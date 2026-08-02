import { describe, expect, it } from "vitest";
import { normalizeFitReport, normalizeHardwareReport } from "../contracts";

const hardware = {
  os: "linux",
  arch: "x86_64",
  cpuBrand: "Test CPU",
  cpuCores: 8,
  totalMemoryBytes: 32,
  availableMemoryBytes: 16,
  gpus: [{ name: "Test GPU", vendor: "Test", vramBytes: null }],
};

const model = {
  name: "test",
  family: "dense",
  sizeLabel: "7B",
  fits: true,
  reason: "fits",
  recommendedQuant: "Q4_K_M",
};

describe("normalizeFitReport", () => {
  it("preserves the current camelCase payload", () => {
    const raw = {
      ramBytes: 16,
      vramBytes: 8,
      fits: [model],
      partial: [],
      tooBig: [],
    };

    expect(normalizeFitReport(raw)).toEqual(raw);
  });

  it("drops malformed model entries", () => {
    expect(normalizeFitReport({ fits: [model, null], partial: ["bad"], tooBig: [{}] })).toEqual({
      ramBytes: 0,
      vramBytes: 0,
      fits: [model],
      partial: [],
      tooBig: [],
    });
  });

  it.each([
    null,
    {},
    { ramBytes: Infinity, vramBytes: NaN, fits: null, partial: "no", tooBig: {} },
  ])("defaults missing or invalid report fields", (raw) => {
    expect(normalizeFitReport(raw)).toEqual({
      ramBytes: 0,
      vramBytes: 0,
      fits: [],
      partial: [],
      tooBig: [],
    });
  });
});

describe("normalizeHardwareReport", () => {
  it("preserves a valid current camelCase payload", () => {
    expect(normalizeHardwareReport(hardware)).toEqual(hardware);
  });

  it.each([
    null,
    {},
    { ...hardware, cpuBrand: undefined },
    { ...hardware, cpuCores: "8" },
    { ...hardware, gpus: [{}] },
    {
      os: "linux",
      arch: "x86_64",
      cpu_brand: "Test CPU",
      cpu_cores: 8,
      total_memory_bytes: 32,
      available_memory_bytes: 16,
      gpus: [],
    },
  ])("rejects malformed hardware payloads", (raw) => {
    expect(() => normalizeHardwareReport(raw)).toThrow(/hardware/i);
  });
});
