import { createHash } from "node:crypto";
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

  it("does not read the catalog or write history through an RPC queued after disposal", async () => {
    const host = harness();
    const close = await plugin.setup(host.ctx);
    await close?.();
    const reads = host.counters.list;
    const saved = JSON.stringify([...host.storage.values()]);
    host.addSource(B());
    expect(await rows(host)).toEqual([]);
    expect(host.counters.list).toBe(reads);
    expect(JSON.stringify([...host.storage.values()])).toBe(saved);
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

  it("isolates locations and keeps confirmed targets across policy changes", async () => {
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
    const baseline = (await rows(renamed))[0]?.transition;
    expect(baseline?.from).toBe("p/model-a");
    // Selection-policy change with an unchanged target: no new transition and
    // the existing one (including its id) survives.
    const narrowed = createHarness({
      storage,
      sources: [B()],
      options: { aliases: { "p/latest": { match: "p/model-b" } } },
      directory: "/virtual/history",
    });
    await plugin.setup(narrowed.ctx);
    expect((await rows(narrowed))[0]?.transition).toEqual(baseline);
    // Selection-policy change that flips the effective target transitions.
    const changed = createHarness({
      storage,
      sources: [A()],
      options: { aliases: { "p/latest": { match: "p/model-a" } } },
      directory: "/virtual/history",
    });
    await plugin.setup(changed.ctx);
    expect((await rows(changed))[0]?.transition).toMatchObject({
      from: "p/model-b",
      to: "p/model-a",
    });
  });

  it("treats exclude changes as effective target changes and reverses them", async () => {
    const storage = new Map<string, unknown>();
    const base = harness(storage, [A()]);
    await plugin.setup(base.ctx);
    expect((await rows(base))[0]?.transition).toBeUndefined();
    const excluded = createHarness({
      storage,
      sources: [A(), B()],
      options: { aliases: { "p/latest": { match: "p/model-*", exclude: "p/model-a" } } },
      directory: "/virtual/history",
    });
    await plugin.setup(excluded.ctx);
    const switched = (await rows(excluded))[0]?.transition;
    expect(switched).toMatchObject({ from: "p/model-a", to: "p/model-b" });
    expect((await rows(excluded))[0]?.transition?.id).toBe(switched?.id);
    const reversed = harness(storage, [A()]);
    await plugin.setup(reversed.ctx);
    const back = (await rows(reversed))[0]?.transition;
    expect(back).toMatchObject({ from: "p/model-b", to: "p/model-a" });
    expect(back?.id).not.toBe(switched?.id);
    // Restart with the same target keeps the reversal transition untouched.
    const restart = harness(storage, [A()]);
    await plugin.setup(restart.ctx);
    expect((await rows(restart))[0]?.transition).toEqual(back);
  });

  it("records filter-induced replacement and preserves the last valid target through the unresolved interval", async () => {
    const storage = new Map<string, unknown>();
    const wideSource = sourceModel({
      providerID: "p",
      id: "model-b",
      modelID: "wire-b",
      released: 200,
      limit: { context: 400_000, output: 8_192 },
    });
    const narrowOptions = {
      aliases: { "p/latest": { match: "p/model-*", filter: { minContext: 300_000 } } },
    };
    await plugin.setup(harness(storage, [A()]).ctx);
    // The filter excludes every candidate: still configured, unresolved, and
    // no more confirmations in between — the recovery below proves the target
    // survived only if the unresolved interval preserved it.
    const unresolved = createHarness({
      storage,
      sources: [A()],
      options: narrowOptions,
      directory: "/virtual/history",
    });
    await plugin.setup(unresolved.ctx);
    expect((await rows(unresolved))[0]).toMatchObject({ status: "unresolved" });
    expect((await rows(unresolved))[0]?.transition).toBeUndefined();
    const eligible = createHarness({
      storage,
      sources: [A(), wideSource],
      options: narrowOptions,
      directory: "/virtual/history",
    });
    await plugin.setup(eligible.ctx);
    const row = (await rows(eligible))[0];
    expect(row?.target).toBe("model-b");
    expect(row?.transition).toMatchObject({ from: "p/model-a", to: "p/model-b" });
    const repeat = createHarness({
      storage,
      sources: [A(), wideSource],
      options: narrowOptions,
      directory: "/virtual/history",
    });
    await plugin.setup(repeat.ctx);
    expect((await rows(repeat))[0]?.transition).toEqual(row?.transition);
  });

  it("does not overwrite history when an invalid strict setup fails", async () => {
    const storage = new Map<string, unknown>();
    await plugin.setup(harness(storage, [A()]).ctx);
    const baseline = JSON.stringify([...storage.values()]);
    const failed = createHarness({
      storage,
      sources: [B()],
      options: { strict: true, aliases: { "p/latest": { match: "p/model-a" } } },
      directory: "/virtual/history",
    });
    await expect(plugin.setup(failed.ctx)).rejects.toThrow("strict");
    expect(JSON.stringify([...storage.values()])).toBe(baseline);
    const recovered = createHarness({
      storage,
      sources: [A(), B()],
      options,
      directory: "/virtual/history",
    });
    await plugin.setup(recovered.ctx);
    expect((await rows(recovered))[0]?.transition).toMatchObject({
      from: "p/model-a",
      to: "p/model-b",
    });
  });

  it("drops history of deleted aliases and starts silently when recreated", async () => {
    const storage = new Map<string, unknown>();
    await plugin.setup(harness(storage, [A()]).ctx);
    const removed = createHarness({
      storage,
      sources: [A()],
      options: { aliases: {} },
      directory: "/virtual/history",
    });
    await plugin.setup(removed.ctx);
    const recreated = createHarness({
      storage,
      sources: [B()],
      options,
      directory: "/virtual/history",
    });
    await plugin.setup(recreated.ctx);
    expect((await rows(recreated))[0]?.target).toBe("model-b");
    expect((await rows(recreated))[0]?.transition).toBeUndefined();
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

describe("ordered selection-policy identity in history", () => {
  const storageKey = `history-v1/${createHash("sha256")
    .update(JSON.stringify(["/virtual/history", ""]))
    .digest("hex")}`;
  const targetA = { providerID: "p", catalogID: "model-a", wireModelID: "wire-a" };
  const seed = (entry: Record<string, unknown>) => {
    const storage = new Map<string, unknown>();
    storage.set(storageKey, { version: 1, aliases: [entry] });
    return storage;
  };

  it("persists the ordered policy with every confirmed baseline", async () => {
    const storage = new Map<string, unknown>();
    await plugin.setup(harness(storage).ctx);
    const saved = storage.get(storageKey) as { aliases: Array<Record<string, unknown>> };
    expect(saved.aliases[0]).toMatchObject({ key: "p/latest", strategy: ["latest"] });
  });

  it("legacy entries without a strategy mean [latest] and stay valid under the same policy", async () => {
    const legacy = { key: "p/latest", policy: "pre-#46-hash", target: targetA };
    const storage = seed(legacy);
    const host = harness(storage);
    await plugin.setup(host.ctx);
    // Baseline is kept: no transition on restart, and no rewrite happens.
    expect((await rows(host))[0]?.transition).toBeUndefined();
    const untouched = JSON.parse(JSON.stringify(storage.get(storageKey)));
    expect((await rows(host))[0]?.transition).toBeUndefined();
    expect(storage.get(storageKey)).toEqual(untouched);
    expect(untouched).toEqual({ version: 1, aliases: [legacy] });
    // A changed strategy resets the legacy baseline: the entry is dropped and
    // the next read persists the canonicalized (empty) state.
    const reset = createHarness({
      storage,
      sources: [A()],
      options: {
        aliases: { "p/latest": { match: "p/model-*", select: { strategy: "cheapest" } } },
      },
      directory: "/virtual/history",
    });
    await plugin.setup(reset.ctx);
    await vi.waitFor(() =>
      expect((storage.get(storageKey) as { aliases: unknown[]; version: number }).aliases).toEqual(
        [],
      ),
    );
  });

  it("a malformed persisted strategy is rejected, never treated as legacy", async () => {
    const storage = seed({
      key: "p/latest",
      policy: "hash",
      strategy: "cheapest",
      target: targetA,
    });
    const host = harness(storage, [B()]);
    await plugin.setup(host.ctx);
    // Without the (dropped) baseline the new target is confirmed silently.
    expect((await rows(host))[0]?.transition).toBeUndefined();
    expect((await rows(host))[0]?.target).toBe("model-b");
    // And the persisted state is rewritten under the valid shape.
    const savedAt = host.storage.get(storageKey) as {
      aliases: Array<{ strategy?: unknown }>;
    };
    expect(savedAt.aliases[0]?.strategy).toEqual(["latest"]);
  });

  it("retains an entry whose stored ordered policy matches, resets otherwise", async () => {
    const base = { key: "p/latest", policy: "hash", target: targetA };
    // Same policy in the same order: kept without a rewrite.
    const kept = seed({ ...base, strategy: ["best", "latest"] });
    const keptHost = createHarness({
      storage: kept,
      sources: [],
      options: { aliases: { "p/latest": { match: "p/model-*", select: { strategy: "best" } } } },
      directory: "/virtual/history",
    });
    await plugin.setup(keptHost.ctx);
    expect(kept.get(storageKey)).toEqual({
      version: 1,
      aliases: [{ ...base, strategy: ["best", "latest"] }],
    });

    // Order matters: a pure reversal of the same criteria resets the
    // baseline too — ["best", "latest"] -> ["latest", "best"].
    const reordered = createHarness({
      storage: kept,
      sources: [],
      options: {
        aliases: { "p/latest": { match: "p/model-*", select: { strategy: ["latest", "best"] } } },
      },
      directory: "/virtual/history",
    });
    await plugin.setup(reordered.ctx);
    await vi.waitFor(() =>
      expect((kept.get(storageKey) as { aliases: unknown[]; version: number }).aliases).toEqual([]),
    );
  });
});
