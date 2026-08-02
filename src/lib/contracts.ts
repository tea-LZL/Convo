import type { FitReport, HardwareReport, ModelFit } from "./api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGpu(value: unknown): boolean {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.vendor === "string"
    && (value.vramBytes === null || isFiniteNumber(value.vramBytes));
}

function isModelFit(value: unknown): value is ModelFit {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.family === "string"
    && typeof value.sizeLabel === "string"
    && typeof value.fits === "boolean"
    && typeof value.reason === "string"
    && (value.recommendedQuant === null || typeof value.recommendedQuant === "string");
}

function modelFits(value: unknown): ModelFit[] {
  return Array.isArray(value) ? value.filter(isModelFit) : [];
}

export function normalizeHardwareReport(raw: unknown): HardwareReport {
  if (
    !isRecord(raw)
    || typeof raw.os !== "string"
    || typeof raw.arch !== "string"
    || typeof raw.cpuBrand !== "string"
    || !isFiniteNumber(raw.cpuCores)
    || !isFiniteNumber(raw.totalMemoryBytes)
    || !isFiniteNumber(raw.availableMemoryBytes)
    || !Array.isArray(raw.gpus)
    || !raw.gpus.every(isGpu)
  ) {
    throw new Error("Invalid hardware report");
  }
  return raw as unknown as HardwareReport;
}

export function normalizeFitReport(raw: unknown): FitReport {
  const report = isRecord(raw) ? raw : {};
  return {
    ramBytes: isFiniteNumber(report.ramBytes) ? report.ramBytes : 0,
    vramBytes: isFiniteNumber(report.vramBytes) ? report.vramBytes : 0,
    fits: modelFits(report.fits),
    partial: modelFits(report.partial),
    tooBig: modelFits(report.tooBig),
  };
}
