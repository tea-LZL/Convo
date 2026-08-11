import { useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/Button";
import { TOUR_STEPS, useTourStore } from "../../stores/tour";

export function TourOverlay() {
  const active = useTourStore((s) => s.active);
  const step = useTourStore((s) => s.step);
  const next = useTourStore((s) => s.next);
  const prev = useTourStore((s) => s.prev);
  const skip = useTourStore((s) => s.skip);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const s = TOUR_STEPS[step];
    if (!s?.target) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = document.querySelector(s.target!);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [active, step]);

  if (!active) return null;
  const s = TOUR_STEPS[step];
  if (!s) return null;

  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[180] pointer-events-none">
      <div className="absolute inset-0 overlay-backdrop pointer-events-auto" onClick={skip} />
      {rect && (
        <div
          className="absolute border-2 border-accent rounded-lg pointer-events-none"
          style={{
            left: rect.x - 4,
            top: rect.y - 4,
            width: rect.w + 8,
            height: rect.h + 8,
            boxShadow: "0 0 0 9999px color-mix(in srgb, var(--color-bg) 40%, transparent)",
          }}
        />
      )}
      <div
        className={`absolute pointer-events-auto max-w-sm bg-surface-1 border border-border rounded-xl shadow-modal p-4 animate-scale-in ${
          rect ? "" : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        }`}
        style={
          rect
            ? {
                left: Math.min(window.innerWidth - 360, Math.max(16, rect.x + rect.w + 16)),
                top: Math.min(window.innerHeight - 220, Math.max(16, rect.y - 8)),
              }
            : undefined
        }
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-text">{s.title}</h3>
          <button onClick={skip} className="text-text-subtle hover:text-text" aria-label="Close tour">
            <X size={14} />
          </button>
        </div>
        <p className="text-xs text-text-muted mt-2 leading-relaxed">{s.body}</p>
        <div className="mt-4 flex items-center justify-between">
          <div className="text-[10px] text-text-subtle">
            {step + 1} of {TOUR_STEPS.length}
          </div>
          <div className="flex items-center gap-1.5">
            {step > 0 && (
              <Button size="xs" variant="ghost" onClick={prev} icon={<ChevronLeft size={12} />}>
                Back
              </Button>
            )}
            <Button size="xs" variant="primary" onClick={next}>
              {isLast ? "Done" : "Next"}
              {!isLast && <ChevronRight size={12} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
