import { ThemeSummary } from "../../stores/theme";

export const defaultDarkTheme: ThemeSummary = {
  id: "default-dark",
  name: "Default Dark",
  is_builtin: true,
  tokens_json: JSON.stringify({
    "color.bg": "#0b0d12",
    "color.surface-1": "#151922",
    "color.text": "#e6e8ee",
    "radius.md": "8px",
    mode: "dark",
  }),
  created_at: "2024-01-01T00:00:00Z",
};

export const customTheme: ThemeSummary = {
  id: "custom-1",
  name: "Solarized",
  is_builtin: false,
  tokens_json: JSON.stringify({
    "color.bg": "#002b36",
    "color.text": "#839496",
  }),
  created_at: "2024-02-01T00:00:00Z",
};

export const themeList = [defaultDarkTheme, customTheme];
