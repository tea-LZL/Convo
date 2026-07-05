import { useEffect, useRef, useState, ReactNode } from "react";

/**
 * AnimatedUnmount — keeps children mounted while an exit animation
 * plays. When `show` becomes false, the component renders the exit
 * class for `duration` ms before actually unmounting.
 *
 * Usage:
 *   <AnimatedUnmount show={open} exitClass="animate-scale-out" duration={150}>
 *     <Dropdown>...</Dropdown>
 *   </AnimatedUnmount>
 */
export function AnimatedUnmount({
  show,
  exitClass = "animate-fade-out",
  duration = 150,
  children,
}: {
  show: boolean;
  exitClass?: string;
  duration?: number;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(show);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (show) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setExiting(false);
      setMounted(true);
    } else if (mounted) {
      setExiting(true);
      timerRef.current = setTimeout(() => {
        setMounted(false);
        setExiting(false);
        timerRef.current = null;
      }, duration);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [show, duration, mounted]);

  if (!mounted) return null;
  return (
    <div className={exiting ? exitClass : undefined} style={exiting ? { animation: undefined } : undefined}>
      {exiting ? <div className={exitClass}>{children}</div> : children}
    </div>
  );
}