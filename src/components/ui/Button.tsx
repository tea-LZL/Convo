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
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-medium transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
