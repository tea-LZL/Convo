# Fix Memory Extract-Facts Schema Mismatch Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Memory → “Extract from chat” accept the model response shown in the error while preserving one canonical `ExtractedFact` contract for the frontend and persisted review records.

**Architecture:** Normalize model-generated JSON once at the Rust extraction boundary, before it becomes `Vec<ExtractedFact>`. Keep the public shape (`kind`, `title`, `content`, `tags`) strict; support only the observed legacy aliases/categories that can be mapped safely, and ignore transient task/request candidates. Strengthen the extraction prompt with a literal schema example, but do not add provider-specific structured-output plumbing or a new schema dependency.

**Tech Stack:** Rust, Tauri commands, `serde_json`, existing Vitest frontend tests, existing Cargo tests.

---

## Root cause and current flow

`src-tauri/src/commands/memory.rs:240-246` defines the canonical fact shape:

- `kind`
- `title`
- `content`
- `tags`

At `src-tauri/src/commands/memory.rs:383-401`, the raw model response is stripped of an optional code fence and deserialized directly with `serde_json::from_str::<Vec<ExtractedFact>>`.

The failing model response uses a different extractor schema:

```json
[
  {"type":"personal_information","fact":"User's Birthday Date","value":"February 18th"},
  {"type":"task/request","fact":"Email Draft Setup","details":"Drafting a birthday invitation email for friends."}
]
```

The first object has no `kind`, so deserialization fails before the Memory UI receives any facts. The second object is transient task content that the existing prompt explicitly says to skip.

Both user-initiated extraction (`src/routes/MemoryRoute.tsx:152-163`) and automatic review extraction (`src/stores/memory.ts:15-28`) call `api.extractFactsFromSession()` (`src/lib/api.ts:508-513`), so the Rust command is the shared fix point. `memory_reviews.rs` and the frontend interfaces already use the canonical shape and should not be widened.

The working tree contains unrelated modifications. Implementation must preserve them and touch only the extraction boundary and its regression tests.

## Scope decisions

- No database migration: review records continue to store canonical facts.
- No frontend/API contract change: `ExtractedFact` remains unchanged.
- No new dependency: `serde_json` is already present.
- No retry loop: a deterministic boundary normalizer is smaller and avoids another provider call.
- No broad “accept any model schema” behavior. Only explicit, tested aliases are supported.

## Implementation steps

### Task 1: Add failing parser regression tests

**Objective:** Capture the exact screenshot response and the canonical contract before changing production code.

**Files:**

- Modify: `src-tauri/src/commands/memory.rs` — add a `#[cfg(test)]` module after the command.

**Step 1: Add a RED test for the observed response**

Test a pure helper API such as `parse_extracted_facts(raw: &str)`. Feed it the response above and assert that it returns exactly one canonical fact:

- `kind == "user_pref"` because `personal_information` maps to user-specific durable memory.
- `title == Some("User's Birthday Date")` from the legacy `fact` field.
- `content == "February 18th"` from the legacy `value` field.
- `tags == None`.

Assert that the `task/request` candidate is not returned.

**Step 2: Add a RED test for the current canonical shape**

Feed the helper a canonical array containing `kind`, `title`, `content`, and `tags`; assert it is returned unchanged.

**Step 3: Add a RED test for malformed top-level data**

Assert that invalid JSON and valid non-array JSON return an actionable error rather than an empty fact list.

**Step 4: Run the focused test and verify it fails for the expected reason**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml commands::memory::tests -- --nocapture
```

Expected: compilation/test failure because the parser helper and normalization behavior do not yet exist.

### Task 2: Normalize the model response at the Rust boundary

**Objective:** Make both Memory extraction callers consume a stable canonical fact list.

**Files:**

- Modify: `src-tauri/src/commands/memory.rs:240-401`.

**Step 1: Add a private wire-normalization helper**

Implement the smallest helper needed by the tests, using `serde_json` and no schema crate:

1. Reuse the existing code-fence stripping behavior.
2. Parse the top-level value and require an array.
3. Read canonical keys first.
4. Support only these observed compatibility fields:
   - `type` as the fallback for `kind`.
   - `fact` as the fallback for `title`.
   - `value` or `details` as the fallback for `content`.
5. Normalize only supported categories:
   - `user_pref`, `project_fact`, `skill` stay canonical.
   - `personal_information` maps to `user_pref`.
   - Explicit project-information and instruction/skill aliases may map to `project_fact` or `skill` only if covered by tests.
   - `task/request` is ignored because it is transient and outside the Memory contract.
   - Unknown categories and objects without usable non-empty content are ignored rather than emitted as invalid Memory items.
6. Return `Ok(vec![])` for a valid array containing no supported durable candidates; return an error for invalid JSON, a non-array top level, or an otherwise unusable response shape that cannot be interpreted as an extraction result.
7. Keep returned values as `ExtractedFact`; do not add serde aliases to the public struct, because aliases would leak the model’s unstable schema into review persistence and frontend code.

**Step 2: Replace direct deserialization**

Replace the `serde_json::from_str::<Vec<ExtractedFact>>` call at the end of `extract_facts_from_session` with the helper. Preserve the existing raw response in parse errors, but include the boundary reason (for example, “expected a JSON array”) so future failures are diagnosable.

**Step 3: Strengthen the extraction prompt**

Update the system prompt at `src-tauri/src/commands/memory.rs:343` to include a literal canonical example and explicit negative instructions:

- Output only an array of objects with exactly `kind`, `title`, `content`, and `tags`.
- Allowed `kind` values are exactly `user_pref`, `project_fact`, and `skill`.
- Never use `type`, `fact`, `value`, or `details` as output keys.
- Never return `task/request` or one-off task details.
- Keep the existing durability rules and maximum of eight candidates.

The prompt improvement is preventative; the normalizer remains the correctness boundary for smaller/local models that still deviate.

**Step 4: Run the focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml commands::memory::tests -- --nocapture
```

Expected: the canonical, screenshot-regression, and malformed-input tests pass.

### Task 3: Verify the shared callers and full project health

**Objective:** Prove the fix covers manual extraction without changing automatic review behavior or the existing IPC contract.

**Files:**

- No additional production files expected.
- Review only: `src/routes/MemoryRoute.tsx`, `src/stores/memory.ts`, `src/lib/api.ts`, and `src-tauri/src/commands/memory_reviews.rs` to confirm they still consume canonical facts.

**Step 1: Run Rust verification**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust tests pass and the command crate checks successfully.

**Step 2: Run the frontend verification trio**

```bash
npm run typecheck
npm run test:run
npm run build
```

Expected: typecheck passes, the full Vitest suite has zero failures, and the Vite build succeeds.

**Step 3: Perform the manual acceptance check**

In the Memory tab:

1. Click **Extract from chat**.
2. Select a session that produces the screenshot response shape.
3. Confirm the parser toast no longer appears.
4. Confirm the review contains the birthday fact as a `user_pref` candidate and does not offer the email-draft task as durable memory.
5. Confirm saving the candidate still creates a normal Memory item.
6. Exercise the automatic `chat-done` review path once and confirm pending/failed/retry behavior is unchanged.

## Acceptance criteria

- The exact screenshot response no longer causes `missing field 'kind'`.
- Canonical model output still round-trips unchanged.
- Unsupported transient task/request entries are not saved as Memory.
- No invalid `kind` values reach `MemoryRoute`, `finish_memory_review`, or `upsert_memory`.
- Both manual and automatic extraction use the same corrected boundary.
- No database migration, frontend contract widening, provider plumbing, or new dependency is introduced.
- Rust tests, `npm run typecheck`, `npm run test:run`, and `npm run build` pass.

## Risks and guardrails

- **Over-normalization:** Keep the alias table explicit and small; do not accept arbitrary keys or map unknown categories to `skill`.
- **Silent model drift:** Preserve actionable errors for invalid JSON/non-array responses and keep the prompt’s exact schema example.
- **Data quality:** Continue requiring non-empty content and never auto-save extracted facts; the existing review UI remains the approval gate.
- **Dirty working tree:** Do not use broad restore/checkout commands. Review the final diff and ensure only the planned extraction code/tests changed.
