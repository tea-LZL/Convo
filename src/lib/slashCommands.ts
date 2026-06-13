/**
 * Slash command system.
 *
 * Slash commands are typed into the composer. When the user hits Enter and
 * the input starts with `/`, we parse the command, run it, and either:
 *   - transform the input (e.g. /search prepends search results)
 *   - perform a side-effect and clear the input (e.g. /new, /clear)
 *   - show an error toast (e.g. /model foo not found)
 */
import { api, SearchConfig, SearchResult } from "../lib/api";
import { toast } from "../stores/toasts";
import { useSessionsStore } from "../stores/sessions";

export interface ParsedCommand {
  name: string;
  args: string;
  raw: string;
}

export interface SlashCommandResult {
  /** If non-null, the composer should be replaced with this text. */
  text?: string;
  /** If true, the composer should be cleared and the result already submitted. */
  sent?: boolean;
  /** If true, the side effect already happened — clear the input. */
  clear?: boolean;
}

export interface SlashCommandContext {
  sessionId: string | null;
  setModelId?: (id: string) => void;
  setProviderId?: (id: string) => void;
  currentModel?: string;
  /** For /regenerate: resend the most recent user message. */
  resendLast?: () => Promise<void>;
  /** For /clear: clear all messages in the active session. */
  clearAll?: () => Promise<void>;
  /** For /new: create a new session and navigate to it. */
  newSession?: () => Promise<void>;
}

export const SLASH_COMMANDS: Array<{
  name: string;
  description: string;
  args?: string;
  run: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandResult> | SlashCommandResult;
}> = [
  {
    name: "help",
    description: "Show available slash commands",
    run: () => {
      const lines = [
        "Available slash commands:",
        ...SLASH_COMMANDS.map((c) =>
          `  /${c.name}${c.args ? " " + c.args : ""}  —  ${c.description}`
        ),
      ];
      toast.info(lines.join("\n"), "Help", 8000);
      return { clear: true };
    },
  },
  {
    name: "new",
    description: "Start a new chat session",
    run: async (_args: string, ctx: SlashCommandContext) => {
      if (ctx.newSession) await ctx.newSession();
      else useSessionsStore.getState().create();
      return { clear: true };
    },
  },
  {
    name: "clear",
    description: "Clear all messages in the current session",
    run: async (_args, ctx) => {
      if (ctx.clearAll) await ctx.clearAll();
      else toast.warn("Clear is not available right now");
      return { clear: true };
    },
  },
  {
    name: "regenerate",
    description: "Resend the last user message",
    run: async (_args, ctx) => {
      if (ctx.resendLast) await ctx.resendLast();
      else toast.warn("Nothing to regenerate");
      return { clear: true };
    },
  },
  {
    name: "model",
    description: "Switch the model for this session",
    args: "<name>",
    run: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        toast.error("Usage: /model <name>");
        return { clear: true };
      }
      if (ctx.setModelId) ctx.setModelId(name);
      else toast.warn("Model switch unavailable");
      return { clear: true };
    },
  },
  {
    name: "search",
    description: "Search the web and prepend the results as context",
    args: "<query>",
    run: async (args) => {
      const q = args.trim();
      if (!q) {
        toast.error("Usage: /search <query>");
        return { clear: true };
      }
      let cfg: SearchConfig | null = null;
      try {
        cfg = await api.getSearchConfig();
      } catch (e) {
        // ignore
      }
      if (!cfg) {
        toast.error("No search provider configured. Add one in Settings → Web search.");
        return { clear: true };
      }
      let results: SearchResult[] = [];
      try {
        results = await api.webSearch(q, cfg);
      } catch (e) {
        toast.error(`Search failed: ${e}`);
        return { clear: true };
      }
      if (results.length === 0) {
        toast.warn("No results");
        return { clear: true };
      }
      const ctx2 = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
        .join("\n\n");
      const text = `Search results for "${q}":\n\n${ctx2}\n\n---\n\nNow answer: ${q}`;
      return { text };
    },
  },
  {
    name: "note",
    description: "Create a note with the given text",
    args: "<text>",
    run: async (args) => {
      const body = args.trim();
      if (!body) {
        toast.error("Usage: /note <text>");
        return { clear: true };
      }
      try {
        await api.upsertNote({ body });
        toast.success("Note created");
      } catch (e) {
        toast.error(String(e));
      }
      return { clear: true };
    },
  },
  {
    name: "task",
    description: "Create a task with the given text",
    args: "<text>",
    run: async (args) => {
      const title = args.trim();
      if (!title) {
        toast.error("Usage: /task <text>");
        return { clear: true };
      }
      try {
        await api.upsertTask({ title });
        toast.success("Task created");
      } catch (e) {
        toast.error(String(e));
      }
      return { clear: true };
    },
  },
];

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const firstSpace = trimmed.indexOf(" ");
  const name = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  return { name: name.toLowerCase(), args, raw: trimmed };
}

export function findCommand(name: string) {
  return SLASH_COMMANDS.find((c) => c.name === name);
}

export function runCommand(parsed: ParsedCommand, ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const cmd = findCommand(parsed.name);
  if (!cmd) {
    toast.error(`Unknown command: /${parsed.name}. Try /help.`);
    return Promise.resolve({ clear: true });
  }
  try {
    return Promise.resolve(cmd.run(parsed.args, ctx));
  } catch (e) {
    toast.error(String(e));
    return Promise.resolve({ clear: true });
  }
}

export function filterCommands(query: string) {
  const q = query.replace(/^\//, "").toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q)
  );
}
