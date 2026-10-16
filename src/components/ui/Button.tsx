import { ButtonHTMLAttributes, forwardRef } from "react";
import { Loader2 } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

/* The focus indicator, and why it is two colours.
 *
 * It was `ring-accent/40`, which the plan carried as a tracked deferral on
 * the grounds that it was "accent on accent" on the two filled variants.
 * Measured, that understated it: a 40%-alpha accent over a dark page is
 * 1.68:1, so the ring was below 3:1 against the *page* on five of the six
 * built-in themes — it was not a filled-button problem, it was a
 * everywhere problem, and it was invisible rather than merely low-contrast.
 *
 * `ring-text` with a `bg` offset puts a high-contrast band against a
 * high-contrast gap, which is the construction WCAG's own focus-appearance
 * guidance describes, and it composes three themes' worth of tokens
 * without adding one:
 *
 *   ring `text` against the offset `bg`   15.52 - 21.00  (page-independent)
 *   offset `bg` against the accent fill    4.80 - 19.56  (page-independent)
 *   ring `text` against the page          12.37 - 21.00
 *
 * All three clear 3:1 in all six built-in themes; the first two do not
 * depend on which surface the button is sitting on, which is what a
 * `ring-offset-*` normally has to guess. The residual is cosmetic: the
 * 2px offset band is `bg`-coloured, so on a `surface-1` or `surface-2`
 * page it is a near-invisible gap rather than a true cut-out. The ring
 * itself is unaffected. `primitives.test.tsx` measures all three legs
 * against `themes.rs` rather than pinning a class name, so a ring change
 * that drops any of them below 3:1 turns the suite red on a number.
 */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-accent hover:bg-accent-hover text-white border border-transparent",
  secondary: "bg-surface-2 hover:bg-surface-3 text-text border border-border",
  ghost: "bg-transparent hover:bg-surface-2 text-text-muted hover:text-text border border-transparent",
  danger: "bg-error/10 hover:bg-error/20 text-error border border-error/30",
  outline: "bg-transparent hover:bg-surface-2 text-text border border-border-strong",
};

const SIZE_CLASSES: Record<Size, string> = {
  xs: "px-2 py-0.5 text-[11px] gap-1 rounded-md",
  sm: "px-2.5 py-1 text-xs gap-1.5 rounded-md",
  md: "px-3.5 py-1.5 text-sm gap-2 rounded-lg",
  lg: "px-4 py-2 text-sm gap-2 rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    rightIcon,
    fullWidth = false,
    className = "",
    children,
    disabled,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
