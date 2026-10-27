# Convo — Goals

**This file is canonical.** If code, README, or any plan contradicts it, the code is wrong.

Last updated: 2026-09-27 · Realignment v1

---

## What Convo is

A **memory-first chat client for Ollama** — local and cloud. Chat is the product.

Not an agent workspace. Not a coding assistant. A chat interface that remembers.

---

## The four things it must do

1. **Recall.** Every turn pulls in the memory that is relevant to it — or correctly pulls in nothing.
2. **Extract and revise.** Durable facts from a conversation are extracted, compared against what is already known, and merged, reinforced, or superseded. The user does not babysit this.
3. **Notes.** Long-form knowledge lives under the Notes tab, is written by the agent during a session when it is warranted, and is recallable in chat like any other memory.
4. **Ollama cloud.** Local and cloud models both work — for chat, for fact extraction, and for embeddings.

## How we know it works

Not vibes. Gates, in this order of priority:

| Gate | Threshold |
|---|---|
| Recall precision | ≥ 90% of known-relevant items in top-6 |
| Recall latency | < 50ms p95 on a 5,000-item corpus. Enforced in `recall_latency_p95_over_five_thousand_items` (`cargo test --release -- --ignored recall_latency`); measured 27.0ms for the both-routes arm, 16.6ms vector-only, 11.6ms keyword-only |
| Recall honesty | Every recalled item explains why it was recalled |
| Stream smoothness | One markdown parse per frozen block; a settled message list commits zero times during a stream. Enforced in `src/components/chat/__tests__/streamPerformance.test.tsx` |
| Autonomy | Extraction + revision run without user action; only genuine ambiguities surface |
| Test floor | Frontend suite never drops below **871** passing tests (measured 2026-10-28); Rust suite never below **318**. Counts only go up. |

---

## Non-goals — the drift lock

These are out of scope. Adding any of them requires a **new explicit decision recorded in this file**, not a side quest or a "while we were in there."

- ❌ MCP servers or clients
- ❌ Tool calling / function calling
- ❌ Agent loops
- ❌ Terminal or shell access
- ❌ File-editing agents, workspace editing, git integration
- ❌ Code-execution sandbox
- ❌ Cloud sync, auto-updater, plugin API
- ❌ Rebuilding the streaming layer *again* without the §8.2 parity gate passing first

**Not a non-goal:** feature deletion. Compare, Documents, Tasks, web search, slash commands, backup/restore, Hardware scan, and Diagnostics all stay. They are demoted in the nav, not removed. The sprawl is a navigation problem.

---

## Architecture law

**Rust owns intelligence. TypeScript is a view.**

Retrieval, scoring, context assembly, extraction, and revision live in Rust. The frontend sends raw input and renders what comes back. A test that greps for ranking logic in `src/` should fail.

---

## The failure mode we are fixing

Convo drifted from "chat client that remembers" into "self-hosted AI workspace" — six nav tabs of unrelated features wrapped around a memory core that was a substring scorer in the browser with a hardcoded `topK` of 3 and no index at all.

The feature sprawl is survivable. The memory core was the actual defect. This rewrite fixes the memory core, demotes the sprawl, and locks the boundary.

---

## Related

- Design spec: `docs/superpowers/specs/2026-09-27-convo-realignment-design.md`
- Implementation plans: `docs/superpowers/plans/`
- Superseded: `.hermes/plans/2026-08-30_113649-convo-release-readiness-knowledge-skill-curation.md` (written for the drifted product; archived, not deleted)
