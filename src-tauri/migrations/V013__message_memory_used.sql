-- What one send actually put in front of the model.
--
-- Provenance only: the memory or note id, the label the prompt grouped it
-- under, and the reason retrieval gave (NULL for a pinned row, which was
-- injected because it is pinned rather than because it ranked). The body is
-- deliberately not copied: it lives in memory_items / notes where the user
-- can edit or delete it, and duplicating private text into every assistant
-- message would multiply what a backup carries and let a stale copy
-- disagree with the Memory tab.
--
-- A JSON array, in the order the rows were emitted. NULL for messages
-- written before this migration — those sends did not record it, and an
-- empty array would claim they used no memory.
--
-- A new migration rather than an amendment to V001: V001 shipped, and a
-- version a database has already recorded is never re-executed.

ALTER TABLE messages ADD COLUMN memory_used TEXT;
