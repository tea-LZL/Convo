interface SkeletonProps {
  width?: string;
  height?: string;
  rounded?: string;
  className?: string;
}

/**
 * Skeleton — a pulsing placeholder for loading states.
 * Uses the `.skeleton` CSS class from globals.css.
 */
export function Skeleton({ width = "100%", height = "1rem", rounded = "rounded-md", className = "" }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${rounded} ${className}`}
      style={{ width, height }}
    />
  );
}

/**
 * ChatSkeleton — a loading placeholder showing 3 message-shaped blocks
 * (a user bubble + assistant text lines) for the chat route.
 *
 * The bubble's radius is matched to `MessageRow`'s, which Task 5 owns:
 * moving one half of a matched pair would make the loading state
 * disagree with the loaded one. Both are `--radius-lg`, and the pin is
 * enforced by comparison rather than by these two literals agreeing —
 * `chatSurface.test.tsx` renders both halves and compares them, so
 * converting one and not the other fails there.
 */
export function ChatSkeleton() {
  return (
    <div className="flex-1 flex flex-col gap-4 p-4 max-w-3xl mx-auto w-full">
      {/* User message bubble */}
      <div className="flex justify-end">
        <Skeleton width="60%" height="2.5rem" rounded="rounded-lg" />
      </div>
      {/* Assistant response lines */}
      <div className="flex flex-col gap-2 w-full">
        <Skeleton width="95%" height="0.875rem" />
        <Skeleton width="88%" height="0.875rem" />
        <Skeleton width="72%" height="0.875rem" />
        <Skeleton width="90%" height="0.875rem" />
        <Skeleton width="65%" height="0.875rem" />
      </div>
    </div>
  );
}
