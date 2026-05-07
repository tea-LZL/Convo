/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
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
        accent: {
          DEFAULT: "#6c5ce7",
          hover: "#7d6ff0",
          muted: "#5a4bd1",
        },
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "pulse-dot": "pulseDot 1.4s infinite ease-in-out both",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseDot: {
          "0%, 80%, 100%": { transform: "scale(0)" },
          "40%": { transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
