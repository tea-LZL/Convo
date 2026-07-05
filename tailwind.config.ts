/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["class", '[data-theme-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        // CSS-variable driven theming. Each color reads from a CSS var.
        bg: "var(--color-bg)",
        surface: {
          1: "var(--color-surface-1)",
          2: "var(--color-surface-2)",
          3: "var(--color-surface-3)",
          4: "var(--color-surface-4)",
        },
        border: {
          DEFAULT: "var(--color-border)",
          strong: "var(--color-border-strong)",
        },
        text: {
          DEFAULT: "var(--color-text)",
          muted: "var(--color-text-muted)",
          subtle: "var(--color-text-subtle)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          hover: "var(--color-accent-hover)",
          muted: "var(--color-accent-muted)",
        },
        success: "var(--color-success)",
        warn: "var(--color-warn)",
        error: "var(--color-error)",
        userbubble: "var(--color-user-bubble)",
        ai: "var(--color-assistant-accent)",
        // Legacy surface-X (kept for backwards compat in existing components)
        "surface-legacy": {
          50: "#f8f9fa",
          100: "#1a1b1e",
          200: "#1e1f23",
          300: "#25262a",
          400: "#2c2d31",
          500: "#313236",
          600: "#38393e",
          700: "#404148",
          800: "#4a4b52",
          900: "#55565e",
        },
        "accent-legacy": {
          DEFAULT: "#6c5ce7",
          hover: "#7d6ff0",
          muted: "#5a4bd1",
        },
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        modal: "var(--shadow-modal)",
      },
      fontFamily: {
        sans: ["var(--font-ui)"],
        mono: ["var(--font-mono)"],
      },
      animation: {
        "fade-in": "fadeIn 0.18s ease-out",
        "fade-out": "fadeOut 0.15s ease-out both",
        "slide-up": "slideUp 0.24s cubic-bezier(0.4, 0, 0.2, 1)",
        "scale-in": "scaleIn 0.16s cubic-bezier(0.4, 0, 0.2, 1)",
        "scale-out": "scaleOut 0.15s cubic-bezier(0.4, 0, 0.2, 1) both",
        "pulse-dot": "pulseDot 1.4s infinite ease-in-out both",
        "ripple": "ripple 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
        "message-in": "messageIn 0.24s ease-out both",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        fadeOut: {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        scaleOut: {
          "0%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0", transform: "scale(0.96)" },
        },
        messageIn: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseDot: {
          "0%, 80%, 100%": { transform: "scale(0)" },
          "40%": { transform: "scale(1)" },
        },
        ripple: {
          "0%": { transform: "scale(0)", opacity: "0.4" },
          "100%": { transform: "scale(4)", opacity: "0" },
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
