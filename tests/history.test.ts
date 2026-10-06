import { describe, expect, it, vi } from "vitest";
import plugin from "../src/plugin.js";
import type { InspectReportRow } from "../src/report.js";
import { createHarness, sourceModel } from "./harness.js";

const options = { aliases: { "p/latest": { match: "p/model-*" } } };
const model = (id: string, released: number, modelID = id) =>
  sourceModel({ providerID: "p", id, modelID, released });
const A = () => model("model-a", 100, "wire-a");
const B = () => model("model-b", 200, "wire-b");
const harness = (
  storage = new Map<string, unknown>(),
  sources = [A()],
  directory = "/virtual/history",
) => createHarness({ storage, sources, options, directory });
const rows = async (host: ReturnType<typeof harness>) => {
  const result = await host.rpc.handlers[0]?.inspect?.({}, {});
  return (result as { rows: InspectReportRow[] }).rows;
};

describe("confirmed target history", () => {
  it("establishes a silent baseline and detects a restart transition without storing private metadata", async () => {
    const storage = new Map<string, unknown>();
    const first = harness(storage);
    const close = await plugin.setup(first.ctx);
    expect((await rows(first))[0]?.transition).toBeUndefined();
    await close?.();
    const second = harness(storage, [A(), B()]);
    await plugin.setup(second.ctx);
    const row = (await rows(second))[0];
    expect(row?.target).toBe("model-b");
    expect(row?.transition).toMatchObject({
      from: "p/model-a",
      to: "p/model-b",
      fromWireModelID: "wire-a",
      toWireModelID: "wire-b",
    });
    expect(Number.isFinite(Date.parse(row?.transition?.changedAt ?? ""))).toBe(true);
    expect((await rows(second))[0]?.transition).toEqual(row?.transition);
    const saved = JSON.stringify([...storage.values()]);
    expect(saved).not.toMatch(/headers|settings|credentials|cost|capabilities/);
    const third = harness(storage, [B()]);
    await plugin.setup(third.ctx);
    expect((await rows(third))[0]?.transition).toEqual(row?.transition);
  });

  it("preserves the baseline through unresolved intervals, including a later move to an older model", async () => {
    const host = harness();
    await plugin.setup(host.ctx);
    host.removeSource("p", "model-a");
    expect((await rows(host))[0]).toMatchObject({ status: "unresolved" });
    expect((await rows(host))[0]?.target).toBeUndefined();
    host.addSource(A());
    expect((await rows(host))[0]?.transition).toBeUndefined();
    host.addSource(B());
    const transition = (await rows(host))[0]?.transition;
    host.removeSource("p", "model-b");
    host.removeSource("p", "model-a");
    expect((await rows(host))[0]).toMatchObject({ status: "unresolved", transition });
    host.addSource(A());
    expect((await rows(host))[0]?.transition).toMatchObject({ from: "p/model-b", to: "p/model-a" });
  });

  it("does not commit disabled, conflicting or failed final mappings", async () => {
    const host = harness();
    await plugin.setup(host.ctx);
    const baseline = JSON.stringify([...host.storage.values()]);
    host.addSource(B());
    const policy = await host.ctx.model.transform((editor) => {
      editor.update("p", "latest", (alias) => {
        alias.enabled = false;
      });
    });
    expect((await rows(host))[0]?.status).toBe("inactive");
    expect(JSON.stringify([...host.storage.values()])).toBe(baseline);
    await policy.dispose();
    const rewrite = await host.ctx.model.transform((editor) => {
      editor.update("p", "latest", (alias) => {
        Object.assign(alias, { modelID: "different-wire" });
      });
    });
    expect(await rows(host)).toEqual([]);
    expect(JSON.stringify([...host.storage.values()])).toBe(baseline);
    await rewrite.dispose();
    host.failNextList(new Error("refresh failed"));
    expect(await rows(host)).toEqual([]);
    expect(JSON.stringify([...host.storage.values()])).toBe(baseline);
    expect((await rows(host))[0]?.transition).toMatchObject({ from: "p/model-a", to: "p/model-b" });
  });

  it("records execution identity changes even if the catalog identity does not change", async () => {
    const host = harness();
    await plugin.setup(host.ctx);
    host.addSource(model("model-a", 100, "wire-b"));
    expect((await rows(host))[0]?.transition).toMatchObject({
      from: "p/model-a",
      to: "p/model-a",
      fromWireModelID: "wire-a",
      toWireModelID: "wire-b",
    });
  });

  it("does not persist a transition when setup rolls back after RPC registration fails", async () => {
    const storage = new Map<string, unknown>();
    await plugin.setup(harness(storage).ctx);
    const baseline = JSON.stringify([...storage.values()]);
    const failed = createHarness({
      storage,
      sources: [B()],
      options,
      directory: "/virtual/history",
      rpcRegisterError: new Error("registration failed"),
    });
    await expect(plugin.setup(failed.ctx)).rejects.toThrow("registration failed");
    expect(JSON.stringify([...storage.values()])).toBe(baseline);
    expect(failed.callbacks).toHaveLength(0);
  });

  it("isolates locations and resets only changed effective policies", async () => {
    const storage = new Map<string, unknown>();
    await plugin.setup(harness(storage).ctx);
    const other = harness(storage, [B()], "/virtual/other");
    await plugin.setup(other.ctx);
    expect((await rows(other))[0]?.transition).toBeUndefined();
    const workspace = createHarness({
      storage,
      sources: [B()],
      options,
      directory: "/virtual/history",
      workspaceID: "different",
    });
    await plugin.setup(workspace.ctx);
    expect((await rows(workspace))[0]?.transition).toBeUndefined();
    const renamed = createHarness({
      storage,
      sources: [B()],
      options: {
        ...options,
        debug: true,
        aliases: { "p/latest": { match: ["p/model-*"], name: "Renamed" } },
      },
      directory: "/virtual/history",
    });
    await plugin.setup(renamed.ctx);
    expect((await rows(renamed))[0]?.transition?.from).toBe("p/model-a");
    const changed = createHarness({
      storage,
      sources: [A()],
      options: { aliases: { "p/latest": { match: "p/model-a" } } },
      directory: "/virtual/history",
    });
    await plugin.setup(changed.ctx);
    expect((await rows(changed))[0]?.transition).toBeUndefined();
  });

  it("treats corrupt state as a fresh baseline and tolerates storage failures", async () => {
    const storage = new Map<string, unknown>();
    await plugin.setup(harness(storage).ctx);
    const key = [...storage.keys()][0] as string;
    storage.set(key, { version: 999, aliases: [{ target: "wrong" }] });
    const corrupt = harness(storage, [B()]);
    await plugin.setup(corrupt.ctx);
    expect((await rows(corrupt))[0]?.transition).toBeUndefined();
    const host = harness();
    vi.spyOn(host.ctx.storage, "get").mockRejectedValue(new Error("private storage error"));
    const write = vi
      .spyOn(host.ctx.storage, "set")
      .mockRejectedValue(new Error("private storage error"));
    await plugin.setup(host.ctx);
    host.addSource(B());
    const transition = (await rows(host))[0]?.transition;
    expect(transition?.to).toBe("p/model-b");
    write.mockRestore();
    expect((await rows(host))[0]?.transition).toEqual(transition);
    expect(host.storage.size).toBe(1);
  });

  it("observes native model.updated events headlessly and releases its event subscription", async () => {
    const host = harness();
    const close = await plugin.setup(host.ctx);
    const baseline = JSON.stringify([...host.storage.values()]);
    host.addSource(B());
    host.emitModelUpdate({ directory: "/unrelated" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.stringify([...host.storage.values()])).toBe(baseline);
    host.emitModelUpdate({ directory: "/virtual/history" });
    await vi.waitFor(() =>
      expect(JSON.stringify([...host.storage.values()])).toContain('"to":"p/model-b"'),
    );
    await close?.();
    expect(host.callbacks).toHaveLength(0);
  });
});
