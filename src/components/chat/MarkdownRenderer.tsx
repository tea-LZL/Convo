import React from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";

// Module-level constants. Stable references so React.memo's shallow
// prop comparison sees only `content` change between renders. The
// `code` function takes all its data from props — no outer state
// captured — so it's safe to share across all MarkdownRenderer
// instances.
const REMARK_PLUGINS = [remarkGfm];

export const MARKDOWN_COMPONENTS = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || "");
    const codeStr = String(children).replace(/\n$/, "");
    const inline = !match && !String(children).includes("\n");
    if (inline) {
      return <code className="bg-surface-2 rounded px-1 py-0.5 text-xs" {...props}>{children}</code>;
    }
    return (
      <div className="code-block-wrap my-2">
        <button
          className="code-copy"
          onClick={(e) => { navigator.clipboard.writeText(codeStr); e.preventDefault(); }}
        >
          Copy
        </button>
        <span className="code-lang">{match ? match[1] : "code"}</span>
        <SyntaxHighlighter
          style={oneDark}
          language={match ? match[1] : "text"}
          PreTag="div"
          customStyle={{ margin: 0, borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface-1)" }}
        >
          {codeStr}
        </SyntaxHighlighter>
      </div>
    );
  },
};

/**
 * Code rendering for the live streaming tail.
 *
 * Deliberately does not syntax-highlight. An open fence is the tail's
 * entire content for as long as it streams, so it re-renders every frame,
 * and Prism re-highlighting a growing 200-line block measured at ~170ms
 * per frame — 6fps, not 60fps. The previous DOM-direct renderer had the
 * same trade (append-mode plain text, highlighted once on close) for the
 * same reason.
 *
 * The text content and the block structure are identical either way, so
 * nothing shifts when the stream ends and the message re-renders with
 * highlighting. Only colour and the copy button arrive late.
 */
const STREAMING_MARKDOWN_COMPONENTS = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || "");
    const codeStr = String(children).replace(/\n$/, "");
    const inline = !match && !String(children).includes("\n");
    if (inline) {
      return <code className="bg-surface-2 rounded px-1 py-0.5 text-xs" {...props}>{children}</code>;
    }
    return (
      <pre style={{ margin: 0, borderRadius: 10, border: "1px solid var(--color-border)", background: "var(--color-surface-1)", overflow: "auto" }}>
        <code className={match ? `language-${match[1]}` : undefined}>{codeStr}</code>
      </pre>
    );
  },
};

/**
 * Wrapped in React.memo. With the module-level REMARK_PLUGINS and
 * MARKDOWN_COMPONENTS above, the only prop the parent ever changes
 * between renders is `content`. When the message row re-renders
 * with the same content (e.g. every chunk-bump on a static
 * completed message), the memo skips the re-render and
 * react-markdown + react-syntax-highlighter are not invoked.
 *
 * This is the load-bearing optimization for the stream-time lag:
 * v0.6.5's incremental DOM fix was correct but the parent
 * re-rendered 60Hz and re-parsed markdown on every static message
 * each time, saturating the main thread.
 */
export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  content,
  streaming = false,
}: {
  content: string;
  /** Render without syntax highlighting. See STREAMING_MARKDOWN_COMPONENTS. */
  streaming?: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      components={streaming ? STREAMING_MARKDOWN_COMPONENTS : MARKDOWN_COMPONENTS}
    >
      {content}
    </Markdown>
  );
});