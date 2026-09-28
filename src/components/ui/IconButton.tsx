import { ReactNode } from "react";

interface IconButtonProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  variant?: "ghost" | "subtle" | "solid";
  size?: "sm" | "md";
  active?: boolean;
  className?: string;
  disabled?: boolean;
}

const SIZES = { sm: "w-7 h-7", md: "w-8 h-8" };
const ICON_SIZES = { sm: 14, md: 16 };
// `FOCUS_RING` is Button's, for the measurement behind it: the old
// `ring-accent/40` sat at 1.68:1 against the page on five of six themes.
// The 32px target is the WCAG 2.2 minimum, and it is the reason a 2px
// outset ring with a 2px offset cannot clip against its own hit area.
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const VARIANTS = {
  ghost: "text-text-muted hover:text-text hover:bg-surface-2",
  subtle: "text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 border border-border",
  solid: "text-white bg-accent hover:bg-accent-hover border border-transparent",
};

export function IconButton({ icon, label, onClick, variant = "ghost", size = "md", active = false, className = "", disabled = false }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING} ${SIZES[size]} ${active ? "bg-accent/15 text-accent hover:bg-accent/20" : VARIANTS[variant]} ${className}`}
    >
      <span style={{ display: "inline-flex" }}>
        {icon && (() => {
          if (typeof icon === "object" && icon && "type" in icon) {
            return <icon.type {...icon.props} size={ICON_SIZES[size]} />;
          }
          return icon;
        })()}
      </span>
    </button>
  );
}
