import type { Plugin } from "@opencode/plugin/tui";
import { describe, expect, it, vi } from "vitest";
import { ModelAliasesRpc } from "../src/rpc.js";
import plugin from "../src/tui.js";

interface KeymapCommand {
  id?: string;
  title?: string;
  description?: string;
  group?: string;
  enabled?: boolean | (() => boolean);
  bind?: false | string;
  palette?: true;
  slash?: {
    name: string;
    aliases?: string[];
    arguments?: true;
  };
  suggested?: boolean | (() => boolean);
  run: (input?: string, event?: unknown) => void | false | Promise<void>;
}

interface KeymapLayer {
  mode?: string;
  enabled?: boolean | (() => boolean);
  commands?: readonly KeymapCommand[];
  bindings?: readonly string[];
}

interface SlotClaim {
  append: "app";
  render: () => null;
}

interface StrictContextOptions {
  location?: { directory: string } | undefined;
  defaultLocation?: { directory: string } | undefined;
  inspectHandler?:
    | ((
        input: Record<string, never>,
        options?: { location?: unknown } | undefined,
      ) => Promise<unknown>)
    | undefined;
}

function createStrictContext(options?: StrictContextOptions) {
  const registeredLayers: Array<() => KeymapLayer> = [];
  const returnedLayers: KeymapLayer[] = [];
  const activeCommands: KeymapCommand[] = [];
  const alerts: Array<{ title: string; message: string }> = [];
  const inspectCalls: Array<{ input: unknown; options?: unknown }> = [];

  const defaultLoc = options?.defaultLocation ?? { directory: "/default/workspace" };

  let slotDisposed = false;
  let activeAppRender: (() => null) | null = null;

  const forbiddenProxy = (prefix: string) => {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`Forbidden context API accessed: ${prefix}.${String(prop)}`);
        },
      },
    );
  };

  const keymap = {
    layer: vi.fn((build: () => KeymapLayer) => {
      registeredLayers.push(build);
      const layer = build();
      returnedLayers.push(layer);
      if (layer.commands) {
        activeCommands.push(...layer.commands);
      }
    }),
    commands: () => [...activeCommands],
    dispatch: vi.fn(),
    shortcuts: vi.fn(),
    pending: vi.fn(),
    active: vi.fn(),
    mode: {
      current: vi.fn(() => "normal"),
      push: vi.fn(() => () => {}),
    },
  };

  const inspectHandler = options?.inspectHandler ?? (async () => ({ text: "Report text" }));

  const client = {
    rpc: vi.fn((definition: unknown) => {
      expect(definition).toBe(ModelAliasesRpc);
      return {
        inspect: vi.fn(
          async (input: Record<string, never>, rpcOptions?: { location?: unknown }) => {
            inspectCalls.push({ input, options: rpcOptions });
            return inspectHandler(input, rpcOptions);
          },
        ),
      };
    }),
    session: forbiddenProxy("client.session"),
    model: forbiddenProxy("client.model"),
    provider: forbiddenProxy("client.provider"),
  };

  const defaultLocationSpy = vi.fn(() => defaultLoc);

  const data = {
    location: {
      default: defaultLocationSpy,
      agent: forbiddenProxy("data.location.agent"),
      command: forbiddenProxy("data.location.command"),
      integration: forbiddenProxy("data.location.integration"),
      mcp: forbiddenProxy("data.location.mcp"),
      model: forbiddenProxy("data.location.model"),
      provider: forbiddenProxy("data.location.provider"),
      reference: forbiddenProxy("data.location.reference"),
      skill: forbiddenProxy("data.location.skill"),
      sync: vi.fn(),
      invalidate: vi.fn(),
      vcs: forbiddenProxy("data.location.vcs"),
    },
    session: forbiddenProxy("data.session"),
    project: forbiddenProxy("data.project"),
    shell: forbiddenProxy("data.shell"),
    on: vi.fn(),
    listen: vi.fn(),
  };

  const alertSpy = vi.fn(async (opts: { title: string; message: string }) => {
    alerts.push(opts);
  });

  const slotImpl = vi.fn((claim: SlotClaim) => {
    if (claim.append === "app") {
      activeAppRender = claim.render;
      claim.render();
    }
    return vi.fn(() => {
      slotDisposed = true;
      activeAppRender = null;
      activeCommands.length = 0;
    });
  });

  const ui = {
    slot: slotImpl,
    dialog: {
      alert: alertSpy,
      show: forbiddenProxy("ui.dialog.show"),
      set: forbiddenProxy("ui.dialog.set"),
      clear: forbiddenProxy("ui.dialog.clear"),
      confirm: forbiddenProxy("ui.dialog.confirm"),
      prompt: forbiddenProxy("ui.dialog.prompt"),
      select: forbiddenProxy("ui.dialog.select"),
    },
    toast: forbiddenProxy("ui.toast"),
    router: forbiddenProxy("ui.router"),
    panel: forbiddenProxy("ui.panel"),
    tabs: forbiddenProxy("ui.tabs"),
    format: {
      path: (p: string) => p,
    },
  };

  const context: Record<string, unknown> = {
    options: {},
    location: options?.location,
    app: { version: "2.0.22", channel: "stable" },
    renderer: {},
    client,
    data,
    attention: forbiddenProxy("attention"),
    theme: {},
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: vi.fn() },
    keymap,
    storage: forbiddenProxy("storage"),
    ui,
  };

  return {
    context: context as unknown as Plugin.Context,
    keymap,
    client,
    data,
    ui,
    alertSpy,
    defaultLocationSpy,
    slotImpl,
    alerts,
    inspectCalls,
    activeCommands,
    returnedLayers,
    remountSlot: () => {
      activeCommands.length = 0;
      if (activeAppRender) {
        activeAppRender();
      }
    },
    isSlotDisposed: () => slotDisposed,
  };
}

describe("opencode-model-aliases TUI plugin", () => {
  it("satisfies Plugin.Definition and loads without Solid/DOM renderer dependencies", () => {
    expect(plugin.id).toBe("opencode-model-aliases");
    expect(typeof plugin.setup).toBe("function");
  });

  it("claims the app slot via context.ui.slot and registers discoverable command on slot render", () => {
    const harness = createStrictContext();
    const cleanup = plugin.setup(harness.context);

    expect(harness.slotImpl).toHaveBeenCalledTimes(1);
    expect(harness.slotImpl).toHaveBeenCalledWith(expect.objectContaining({ append: "app" }));

    expect(harness.activeCommands).toHaveLength(1);
    const command = harness.activeCommands[0];
    expect(command?.id).toBe("opencode-model-aliases.inspect");
    expect(command?.title).toBe("Model aliases");
    expect(command?.palette).toBe(true);
    expect(command?.slash).toEqual({
      name: "model-aliases",
      arguments: true,
    });
    expect(typeof command?.run).toBe("function");

    expect(harness.returnedLayers).toHaveLength(1);
    expect(harness.returnedLayers[0]?.mode).toBe("global");

    if (typeof cleanup === "function") {
      cleanup();
    }
  });

  it("forwards explicit context.location to inspect RPC", async () => {
    const harness = createStrictContext({
      location: { directory: "/explicit/project" },
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];
    expect(command).toBeDefined();

    await command?.run();

    expect(harness.inspectCalls).toHaveLength(1);
    expect(harness.inspectCalls[0]).toEqual({
      input: {},
      options: { location: { directory: "/explicit/project" } },
    });
    expect(harness.defaultLocationSpy).not.toHaveBeenCalled();
  });

  it("falls back to context.data.location.default() when context.location is undefined", async () => {
    const harness = createStrictContext({
      location: undefined,
      defaultLocation: { directory: "/fallback/default" },
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];
    expect(command).toBeDefined();

    await command?.run();

    expect(harness.defaultLocationSpy).toHaveBeenCalledTimes(1);
    expect(harness.inspectCalls).toHaveLength(1);
    expect(harness.inspectCalls[0]).toEqual({
      input: {},
      options: { location: { directory: "/fallback/default" } },
    });
  });

  it("strictly touches only inspection RPC and context.ui.dialog.alert without forbidden APIs", async () => {
    const harness = createStrictContext({
      location: { directory: "/isolated" },
      inspectHandler: async () => ({ text: "Aliases active:\n  sonnet -> sonnet-4" }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.inspectCalls).toHaveLength(1);
    expect(harness.alerts).toEqual([
      { title: "Model aliases", message: "Aliases active:\n  sonnet -> sonnet-4" },
    ]);
  });

  it("presents the report text in dialog alert on valid response", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Configured aliases:\n  fast: gpt-4o-mini\n  smart: claude-3-7-sonnet",
      }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    expect(harness.alerts[0]).toEqual({
      title: "Model aliases",
      message: "Configured aliases:\n  fast: gpt-4o-mini\n  smart: claude-3-7-sonnet",
    });
  });

  it("allows palette invocation (undefined) and empty slash invocation ('', '   ')", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({ text: "Report OK" }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run(undefined);
    expect(harness.inspectCalls).toHaveLength(1);

    await command?.run("");
    expect(harness.inspectCalls).toHaveLength(2);

    await command?.run("    ");
    expect(harness.inspectCalls).toHaveLength(3);

    expect(harness.alerts).toHaveLength(3);
    for (const alert of harness.alerts) {
      expect(alert).toEqual({ title: "Model aliases", message: "Report OK" });
    }
  });

  it("rejects unexpected arguments via local usage dialog without calling RPC", async () => {
    const harness = createStrictContext();
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run("extra-argument");

    expect(harness.inspectCalls).toHaveLength(0);
    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]?.title).toBe("Model aliases");
    expect(harness.alerts[0]?.message).toMatch(/unexpected arguments/i);

    await command?.run("  --flag  ");
    expect(harness.inspectCalls).toHaveLength(0);
    expect(harness.alerts).toHaveLength(2);
  });

  it("displays grounded retry/reload advice dialog when response is malformed", async () => {
    for (const malformed of [
      null,
      undefined,
      {},
      { text: 123 },
      { different: "shape" },
      "not an object",
    ]) {
      const harness = createStrictContext({
        inspectHandler: async () => malformed,
      });
      plugin.setup(harness.context);
      const command = harness.activeCommands[0];

      await command?.run();

      expect(harness.alerts).toHaveLength(1);
      expect(harness.alerts[0]?.title).toBe("Model aliases");
      expect(harness.alerts[0]?.message).toMatch(/unable to load model aliases/i);
      expect(harness.alerts[0]?.message).toMatch(/reload|try again/i);
    }
  });

  it("displays grounded retry/reload advice dialog on RPC error without leaking full error dump", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => {
        throw new Error("SECRET_TOKEN=xyz network timeout");
      },
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]?.title).toBe("Model aliases");
    expect(harness.alerts[0]?.message).toBe(
      "Unable to load model aliases. Please reload or try again.",
    );
    expect(harness.alerts[0]?.message).not.toContain("SECRET_TOKEN");
  });

  it("cleans up on teardown and does not duplicate keymap commands on remount", () => {
    const harness = createStrictContext();
    const cleanup = plugin.setup(harness.context);

    expect(harness.activeCommands).toHaveLength(1);

    harness.remountSlot();
    expect(harness.activeCommands).toHaveLength(1);

    if (typeof cleanup === "function") {
      cleanup();
    }
    expect(harness.isSlotDisposed()).toBe(true);
    expect(harness.activeCommands).toHaveLength(0);
  });
});
