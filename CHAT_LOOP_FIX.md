# Chat Infinite Loop — Root Cause Analysis & Fix Plan

## Summary

The "conversation loops indefinitely" bug is caused by a missing terminal
event on the Rust streaming side, compounded by a double-append of the user
message and a missing cleanup of the cancel-token map. The result: when a
provider stream ends without sending a `done: true` chunk (reproducible with
several OpenAI-compat servers and certain Ollama model exits), the Rust task
exits silently, the frontend never receives `chat-done`, and
`s.streaming` stays `true` forever — the UI spins the streaming dots
indefinitely and the send button stays disabled. In some configurations the
stale cancel-token further triggers a spurious `chat-cancelled` event that
appends "[stopped]" messages while a new stream is active, creating visible
conversation looping.

---

## Root Causes (4 bugs, ordered by impact)

### Bug 1 (CRITICAL): Stream ends without terminal event → frontend hangs forever

**File**: `src-tauri/src/commands/chat_stream.rs:126-188`

The tokio::spawn loop only emits `chat-done` when `chunk.done == true`.
If the provider stream ends (rx.recv() returns `None`) WITHOUT ever sending
a done chunk — which happens with:
  - OpenAI-compat servers that close the SSE stream without `[DONE]` or
    `finish_reason` (some vLLM/llama.cpp configurations)
  - Network interruptions that drop the HTTP connection cleanly
  - Ollama streams killed by the server (OOM, model unload)

…then the loop hits `None => break` at line 184 and the task exits.
**No** `chat-done`, `chat-error`, or `chat-cancelled` event is emitted.

The frontend's `chat-done` handler (chatStream.ts:141-192) is the only
place that sets `s.streaming = false`. Without it, `s.streaming` stays
`true` forever. The UI:
  - StreamingSection keeps rendering the pulsing dots
  - ChatInput stays `disabled={chat.streaming || !modelId}` → send button
    is greyed out
  - The user observer the conversation "loop" — the streaming indicator
    never stops, even though the model is done generating

### Bug 2 (HIGH): Stale cancel-token triggers spurious chat-cancelled

**File**: `src-tauri/src/commands/chat_stream.rs:112-116` + `streams.rs`

When a stream starts, a `oneshot::Sender` is inserted into the
`ActiveStreams` map keyed by session_id:

```rust
let (tx, rx_cancel) = oneshot::channel::<()>();
map.insert(args.session_id.clone(), tx);
```

When the stream completes normally (chat-done emitted, loop breaks), the
tx is **never removed** from the map. If the user sends a new message:

1. `chat_stream_v2` inserts a NEW tx, REPLACING the old tx in the map
2. The old tx is dropped
3. The old tokio task's `rx_cancel` arm fires (oneshot sender dropped =
   receiver gets Err), setting `was_cancelled = true`
4. The old task emits `chat-cancelled` for this session_id
5. The frontend's chat-cancelled handler (chatStream.ts:216-246) fires,
   appending a `"[stopped]"` assistant message from the old partial content
6. The NEW stream is still active — the chat-chunk handler ras s.streaming
   back to true, but the old "[stopped]" message is now in s.messages

This creates a visible "loop" effect: the user sends a message, sees a
partial response marked "[stopped]", then the real response streams in.
On the next send, it happens AGAIN, growing the message list with spurious
stopped messages.

### Bug 3 (MEDIUM): Double-append user message to conversation

**Files**: `src/components/chat/ChatViewNew.tsx:154-176` + `src/stores/chatStream.ts:323-372`

`onSend` and `sendMessage` both create independent user messages:

1. `onSend` builds `newMessages = [...chat.messages, userMsg_A]` and calls
   `api.saveMessages()`. DB now has userMsg_A.
2. `onSend` calls `chat.send(text)` → `sendMessage` creates a NEW
   `userMsg_B` (different UUID), appends to `s.messages`.
3. `sendMessage` maps `s.messages` (which has userMsg_B) into
   `cleanMessages` and sends to the LLM.

Normally the store and DB converge after chat-done re-saves. But if
`chat.reload()` is called (from edit & resend, context menu regenerate,
or component remount), `loadSessionMessages` loads userMsg_A from DB,
then `sendMessage` appends userMsg_B → the store has BOTH user messages.
The LLM receives duplicate user messages, which can cause it to
duplicate/echo responses, creating a visible "looping" pattern.

### Bug 4 (LOW): No conversation history truncation

**File**: `src/stores/chatStream.ts:353-357`

`sendMessage` sends the ENTIRE message history to the LLM on every send:

```typescript
const cleanMessages = s.messages.map((m) => ({
  role: m.role,
  content: m.content,
  ...(m.thinking ? { thinking: m.thinking } : {}),
}));
```

For long conversations, the message history exceeds the model's context
window. Ollama silently truncates the oldest messages; OpenAI-compat may
reject the request or the model may start repeating the last pattern
it sees (classic context-overflow degredation). This makes the "loop"
behavior more pronounced with longer conversations.

---

## Step-by-Step Fix Plan

### Step 1: Emit terminal event on stream end (Bug 1)

**File**: `src-tauri/src/commands/chat_stream.rs`

After the `loop { ... }` block, before the `was_cancelled` check, add a
fallback terminal event for the case where the stream ended normally
(was_cancelled == false) but no `chat-done` was emitted:

```rust
// After the loop, before checking was_cancelled:
if !was_cancelled {
    // Stream ended without a done chunk. Emit a synthetic chat-done
    // so the frontend can finalize. Token counts are unknown.
    let _ = app_clone.emit(
        "chat-done",
        serde_json::json!({
            "conversation_id": &session_id,
            "prompt_tokens": null,
            "output_tokens": null,
            "completed_at": chrono::Utc::now().to_rfc3339(),
        }),
    );
}
```

This goes after line 188 (the closing `}` of the loop) and before line 189
(`if was_cancelled {`).

**Verify**: If the stream ends without a done chunk, the frontend now
receives `chat-done` with null token counts, sets `s.streaming = false`,
and saves the partial content as an assistant message.

### Step 2: Clean up ActiveStreams entry after stream completes (Bug 2)

**File**: `src-tauri/src/commands/chat_stream.rs`

The tx needs to be removed from the `ActiveStreams` map when the stream
completes (not just when cancelled). The tokio task needs a reference to
the `ActiveStreams` state to do the cleanup.

In the `chat_stream_v2` function, after creating the tx/rx_cancel pair,
clone the `streams` state for the spawned task:

```rust
let streams_clone = streams.inner().clone();
```

Then inside the spawned task, after the loop exits (whether due to done,
error, or stream-end), remove the entry:

```rust
// After the loop, before the was_cancelled check:
{
    if let Ok(mut map) = streams_clone.0.lock() {
        map.remove(&session_id);
    }
}
```

This ensures the old tx is removed BEFORE it can be dropped by
replacement, preventing the spurious `chat-cancelled` event.

**Verify**: Send a message, wait for it to complete, send another.
No spurious "[stopped]" messages appear.

### Step 3: Remove double-append of user message (Bug 3)

**File**: `src/components/chat/ChatViewNew.tsx`

The `onSend` function currently builds `newMessages` with the user message
and saves to DB, then calls `chat.send` which appends a DIFFERENT user
message to the store. The fix: **don't append the user message in onSend**.
Let `sendMessage` be the single source of truth for user message creation.

Replace `onSend` (lines 154-176) with:

```typescript
const onSend = async (text: string) => {
  stickToBottom.current = true;
  const readyIds = attachments.attachments.filter((a) => a.serverId).map((a) => a.serverId!);
  const attJson = attachments.serializeForMessage(readyIds);
  // sendMessage handles appending the user message to the store and
  // sending to the LLM. We pass the attachment JSON via the opts
  // so it ends up on the message.
  await chat.send(text, { attachmentsJson: attJson });
  // Persist after sendMessage has appended the user message:
  api.saveMessages(sessionId, getOrCreate(sessionId) /* ... */).catch(console.error);
  attachments.clear();
};
```

BUT — `sendMessage` doesn't currently accept `attachmentsJson`. We need
to extend it.

**File**: `src/stores/chatStream.ts`

Extend `SendOpts` to add `attachmentsJson`:

```typescript
export interface SendOpts {
  systemOverride?: string;
  attachmentsJson?: string | null;
}
```

Update the `userMsg` creation in `sendMessage` (line 333-343):

```typescript
const userMsg: ChatMessage = {
  id: crypto.randomUUID(),
  session_id: cid,
  role: "user",
  content: text,
  thinking: null,
  attachments_json: opts.attachmentsJson ?? null,
  prompt_tokens: null,
  output_tokens: null,
  created_at: new Date().toISOString(),
};
s.messages = [...s.messages, userMsg];
// Persist immediately so the user message is on disk before the stream starts:
api.saveMessages(cid, s.messages).catch(() => {});
```

Then `onSend` becomes:

```typescript
const onSend = async (text: string) => {
  stickToBottom.current = true;
  const readyIds = attachments.attachments.filter((a) => a.serverId).map((a) => a.serverId!);
  const attJson = attachments.serializeForMessage(readyIds);
  await chat.send(text, { attachmentsJson: attJson });
  attachments.clear();
};
```

**Also extend `useChat.ts`** to pass `attachmentsJson` through:

```typescript
const send = useCallback(
  async (text: string, options?: { systemOverride?: string; attachmentsJson?: string | null }) => {
    if (!sessionId) return;
    await sendMessage(sessionId, text, modelName, {
      systemOverride: options?.systemOverride,
      attachmentsJson: options?.attachmentsJson,
    });
  },
  [sessionId, modelName]
);
```

And update `UseChat` interface:

```typescript
send: (text: string, options?: { systemOverride?: string; attachmentsJson?: string | null }) => Promise<void>;
```

**Verify**: Send a message — the user message appears ONCE in the UI and
ONCE in the DB. Reload the chat — no duplicates.

### Step 4: Add conversation history truncation (Bug 4)

**File**: `src/stores/chatStream.ts`

In `sendMessage`, before building `cleanMessages`, truncate the history
to a reasonable token budget. This prevents context overflow and the
model-repeating-itself behavior:

```typescript
// Truncate conversation history before sending to the LLM.
// Keep the last N messages (system + last 20 exchanges = 41 messages).
// This is a simple heuristic; a token-count-based truncation would be
// more accurate but requires a tokenizer.
const MAX_HISTORY = 41; // 20 pairs + 1 system
const truncated = s.messages.length > MAX_HISTORY
  ? s.messages.slice(-MAX_HISTORY)
  : s.messages;
const cleanMessages = truncated.map((m) => ({
  role: m.role,
  content: m.content,
  ...(m.thinking ? { thinking: m.thinking } : {}),
}));
```

**Verify**: In a long conversation (50+ messages), send a new message.
The LLM receives only the last 41 messages, not the full history. The
response doesn't degenerate into repetition.

### Step 5: Guard chat-cancelled handler against stale sessions

**File**: `src/stores/chatStream.ts`

As a defense-in-depth measure against Bug 2 (in case Step 2 has a race),
add a generation counter to the chat-cancelled handler so a stale cancel
event doesn't fire for a session that's currently on a new stream:

In `sendMessage`, before `s.streaming = true`:
```typescript
s._cancelGeneration = (s._cancelGeneration ?? 0) + 1;
const myGeneration = s._cancelGeneration;
```

In the `chat-cancelled` handler, check the generation:
```typescript
if (s._cancelGeneration !== undefined && s._cancelGeneration !== myGeneration) return;
```

This requires extending `SessionState` with `_cancelGeneration?: number`.

**Verify**: Even if a stale cancel event arrives, it's ignored because the
generation counter has advanced.

---

## Verification

After all steps:

1. `npm run typecheck && npm run test:run` — must pass
2. `cargo check --manifest-path src-tauri/Cargo.toml` — must pass
3. Manual testing with Ollama: send a message, wait for response.
   - The user message appears ONCE (not twice)
   - The streaming dots stop when the response is done
   - Sending a second message doesn't show "[stopped]"
4. Manual testing with a long conversation (20+ exchanges):
   - The LLM doesn't start repeating itself
   - The context window isn't exceeded
5. Kill the Ollama server mid-stream:
   - The stream should time out and show an error or stopped state
   - The send button should become enabled again