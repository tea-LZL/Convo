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
export const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {content}
    </Markdown>
  );
});