/**
 * Slash command system.
 *
 * Slash commands are typed into the composer. When the user hits Enter and
 * the input starts with `/`, we parse the command, run it, and either:
 *   - transform the input (e.g. /search prepends search results)
 *   - perform a side-effect and clear the input (e.g. /new, /clear)
 *   - show an error toast (e.g. /model foo not found)
 */
import { api, SearchConfig, SearchResult, SlashCommand } from "../lib/api";
import { toast } from "../stores/toasts";
import { useSessionsStore } from "../stores/sessions";
import { useSlashCommandsStore } from "../stores/slashCommands";

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

export interface SlashCommandDescriptor {
  name: string;
  description: string;
  args?: string;
  run: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandResult> | SlashCommandResult;
}

export const SLASH_COMMANDS: SlashCommandDescriptor[] = [
  {
    name: "help",
    description: "Show available slash commands",
    run: () => {
      const lines = [
        "Available slash commands:",
        ...getAvailableCommands().map((c) =>
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
      else await useSessionsStore.getState().create();
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
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const firstSpace = trimmed.indexOf(" ");
  const name = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  return { name: name.toLowerCase(), args, raw: trimmed };
}

export function findCommand(name: string) {
  const builtin = findBuiltinCommand(name);
  if (builtin) return builtin;
  const normalizedName = normalizeCommandName(name);
  if (!normalizedName || !useSlashCommandsStore.getState().loaded) return undefined;
  return getAvailableCommands().find((c) => normalizeCommandName(c.name) === normalizedName);
}

export async function runCommand(parsed: ParsedCommand, ctx: SlashCommandContext): Promise<SlashCommandResult> {
  if (parsed.name.trim().startsWith("/")) {
    toast.error(`Unknown command: /${parsed.name}. Try /help.`);
    return { clear: true };
  }
  let cmd = findBuiltinCommand(parsed.name);
  if (!cmd) {
    const store = useSlashCommandsStore.getState();
    if (!store.loaded) {
      try {
        await store.refresh();
      } catch {
        // Persisted commands are optional; the unknown-command result below
        // keeps built-ins usable when loading fails.
      }
    }
    if (useSlashCommandsStore.getState().loaded) cmd = findCommand(parsed.name);
  }
  if (!cmd) {
    toast.error(`Unknown command: /${parsed.name}. Try /help.`);
    return { clear: true };
  }
  try {
    return await cmd.run(parsed.args, ctx);
  } catch (e) {
    toast.error(String(e));
    return { clear: true };
  }
}

export function filterCommands(query: string, customCommands?: SlashCommand[]) {
  const q = query.replace(/^\//, "").toLowerCase();
  const commands = getAvailableCommands(customCommands);
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q)
  );
}

export function expandCommandBody(body: string, args: string): string {
  const value = args.trim();
  if (body.includes("{{args}}")) return body.replace(/\{\{args\}\}/g, () => value);
  if (!value) return body;
  return `${body}\n\n${value}`;
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

function findBuiltinCommand(name: string): SlashCommandDescriptor | undefined {
  const normalizedName = normalizeCommandName(name);
  if (!normalizedName) return undefined;
  return SLASH_COMMANDS.find((c) => normalizeCommandName(c.name) === normalizedName);
}

export function isCustomCommand(name: string): boolean {
  const normalizedName = normalizeCommandName(name);
  if (!normalizedName || findBuiltinCommand(name)) return false;
  const state = useSlashCommandsStore.getState();
  return state.loaded && state.commands.some((command) => normalizeCommandName(command.name) === normalizedName);
}

function toCustomDescriptor(command: SlashCommand): SlashCommandDescriptor {
  return {
    name: normalizeCommandName(command.name),
    description: command.description?.trim() || "Custom prompt command",
    run: (args) => ({ text: expandCommandBody(command.body, args) }),
  };
}

function getAvailableCommands(
  customCommands: SlashCommand[] = useSlashCommandsStore.getState().commands,
): SlashCommandDescriptor[] {
  const builtinNames = new Set(SLASH_COMMANDS.map((command) => normalizeCommandName(command.name)));
  const customNames = new Set<string>();
  const availableCustomCommands = customCommands
    .map(toCustomDescriptor)
    .filter((command) => {
      const name = normalizeCommandName(command.name);
      if (builtinNames.has(name) || customNames.has(name)) return false;
      customNames.add(name);
      return true;
    });
  return [...SLASH_COMMANDS, ...availableCustomCommands];
}
