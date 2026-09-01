import { describe, expect, it, vi } from "vitest";

vi.mock("vite", () => ({
  defineConfig: (config: unknown) => config,
}));
vi.mock("@vitejs/plugin-react", () => ({
  default: () => ({}),
}));

type ViteServerConfig = {
  port?: number;
  host?: boolean | string;
  hmr?: {
    protocol?: string;
    host?: string;
    port?: number;
  };
};

async function loadServerConfig(host: string): Promise<ViteServerConfig> {
  const previousHost = process.env.TAURI_DEV_HOST;
  vi.resetModules();
  process.env.TAURI_DEV_HOST = host;

  try {
    // @ts-ignore vite.config.ts is owned by the node project reference.
    const { default: config } = await import("../../vite.config");
    const resolved = typeof config === "function" ? await config({ command: "serve", mode: "development" }) : config;
    return (resolved as { server: ViteServerConfig }).server;
  } finally {
    if (previousHost === undefined) {
      delete process.env.TAURI_DEV_HOST;
    } else {
      process.env.TAURI_DEV_HOST = previousHost;
    }
  }
}

describe("Vite Tauri development host policy", () => {
  it.each(["localhost", "127.0.0.1"])("preserves local HMR configuration for %s", async (host) => {
    const server = await loadServerConfig(host);

    expect(server).toMatchObject({
      port: 1420,
      host,
      hmr: { protocol: "ws", host, port: 1421 },
    });
  });

  it("falls back to local-only mode for arbitrary TAURI_DEV_HOST values", async () => {
    const server = await loadServerConfig("dev.example.com");

    expect(server.host).toBe(false);
    expect(server.hmr).toBeUndefined();
  });
});
