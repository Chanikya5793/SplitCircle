/**
 * aiLayer.test.ts — orchestrator fan-out logic (runStep isolation + sequencing).
 * firebase-functions is mocked so importing the module doesn't register a real
 * Cloud Function.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-functions/v2/firestore", () => ({ onDocumentWritten: (_p: string, h: unknown) => h }));
vi.mock("firebase-functions/logger", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { fanOut, runStep, type AiLayerCores } from "./aiLayer";

function makeCores(overrides: Partial<AiLayerCores> = {}): AiLayerCores {
  return {
    runBqSyncForGroup: vi.fn(async () => ({ ok: true })),
    runEmbedForGroup: vi.fn(async () => ({ ok: true })),
    runAutoCategorizeForGroup: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("runStep", () => {
  it("swallows a step failure (never rethrows)", async () => {
    await expect(runStep("x", "g1", async () => { throw new Error("boom"); })).resolves.toBeUndefined();
  });
});

describe("fanOut", () => {
  it("calls all three cores with (groupId, after)", async () => {
    const cores = makeCores();
    const after = { name: "Trip" };
    await fanOut(cores, "g1", after);
    expect(cores.runBqSyncForGroup).toHaveBeenCalledWith("g1", after);
    expect(cores.runEmbedForGroup).toHaveBeenCalledWith("g1", after);
    expect(cores.runAutoCategorizeForGroup).toHaveBeenCalledWith("g1", after);
  });

  it("isolates failures — a throwing step does not block the others", async () => {
    const cores = makeCores({ runEmbedForGroup: vi.fn(async () => { throw new Error("embed down"); }) });
    await expect(fanOut(cores, "g1", undefined)).resolves.toBeUndefined();
    expect(cores.runBqSyncForGroup).toHaveBeenCalledOnce();
    expect(cores.runAutoCategorizeForGroup).toHaveBeenCalledOnce();
  });
});
