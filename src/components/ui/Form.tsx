import { ReactNode, useEffect, useState } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
      <div className="flex-1 min-w-0">
        {label && <p className="text-sm text-text">{label}</p>}
        {description && <p className="text-xs text-text-muted mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? "bg-accent" : "bg-surface-3"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
        />
      </button>
    </label>
  );
}

interface TextInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  disabled?: boolean;
  maxLength?: number;
}

export function TextInput({ value, onChange, placeholder, type = "text", autoFocus, onKeyDown, className = "", disabled, maxLength }: TextInputProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      disabled={disabled}
      maxLength={maxLength}
      className={`w-full bg-surface-2 border border-border rounded-md px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:opacity-50 ${className}`}
    />
  );
}

interface TextAreaProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  className?: string;
  disabled?: boolean;
}

export function TextArea({ value, onChange, placeholder, rows = 3, autoFocus, onKeyDown, className = "", disabled }: TextAreaProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      disabled={disabled}
      className={`w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 resize-y disabled:opacity-50 ${className}`}
    />
  );
}

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
  disabled?: boolean;
}

export function Select({ value, onChange, options, className = "", disabled }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`bg-surface-2 border border-border rounded-md px-2.5 py-1.5 text-sm text-text focus:outline-none focus:border-accent disabled:opacity-50 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  formatValue?: (v: number) => string;
}

export function Slider({ value, onChange, min, max, step = 1, formatValue }: SliderProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--color-accent)]"
      />
      <span className="text-xs text-text-muted tabular-nums w-12 text-right">
        {formatValue ? formatValue(value) : value}
      </span>
    </div>
  );
}

interface TabsProps {
  tabs: Array<{ id: string; label: string; icon?: React.ReactNode }>;
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className = "" }: TabsProps) {
  return (
    <div className={`flex border-b border-border ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3.5 py-2 text-sm font-medium transition-colors relative ${
            active === t.id ? "text-text" : "text-text-muted hover:text-text"
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            {t.icon}
            {t.label}
          </span>
          {active === t.id && (
            <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-accent rounded-t" />
          )}
        </button>
      ))}
    </div>
  );
}

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "accent" | "success" | "warn" | "error";
  className?: string;
}

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  const variants = {
    default: "bg-surface-3 text-text-muted border-border",
    accent: "bg-accent/15 text-accent border-accent/30",
    success: "bg-success/15 text-success border-success/30",
    warn: "bg-warn/15 text-warn border-warn/30",
    error: "bg-error/15 text-error border-error/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

interface TooltipProps {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  const [show, setShow] = useState(false);
  const sideClasses =
    side === "top" ? "bottom-full mb-1.5 left-1/2 -translate-x-1/2" :
    side === "bottom" ? "top-full mt-1.5 left-1/2 -translate-x-1/2" :
    side === "left" ? "right-full mr-1.5 top-1/2 -translate-y-1/2" :
    "left-full ml-1.5 top-1/2 -translate-y-1/2";
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span
          className={`absolute z-50 px-2 py-1 text-[11px] text-text bg-surface-3 border border-border rounded-md shadow-modal whitespace-nowrap pointer-events-none ${sideClasses}`}
        >
          {content}
        </span>
      )}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-border border-t-accent"
      style={{ width: size, height: size }}
    />
  );
}

export function useDebouncedValue<T>(value: T, delay = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}