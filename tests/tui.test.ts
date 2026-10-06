import type { Plugin } from "@opencode/plugin/tui";
import { describe, expect, it, vi } from "vitest";
import { ModelAliasesRpc } from "../src/rpc.js";
import plugin, {
  formatDetailMessage,
  type InspectResponseRow,
  isInspectResponse,
} from "../src/tui.js";

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

interface SelectOption {
  category?: string;
  title: string;
  description?: string;
  footer?: string;
  value: string;
}

interface SelectCall {
  title: string;
  placeholder?: string;
  options: SelectOption[];
}

interface StrictContextOptions {
  notificationStorage?: Map<string, { aliases: Record<string, string> }>;
  storageFailure?: boolean;
  location?: { directory: string } | undefined;
  defaultLocation?: { directory: string } | undefined;
  inspectHandler?:
    | ((
        input: Record<string, never>,
        options?: { location?: unknown } | undefined,
      ) => Promise<unknown>)
    | undefined;
  selectReturnValue?: string | undefined;
}

const SAMPLE_ROW_ACTIVE: InspectResponseRow = {
  key: "github-copilot/sonnet",
  displayName: "Sonnet (alias)",
  provider: "github-copilot",
  alias: "sonnet",
  strategy: "latest",
  status: "active",
  target: "claude-3-5-sonnet-20241022",
  catalogID: "claude-3-5-sonnet-20241022",
  providerID: "github-copilot",
};

const SAMPLE_ACTUAL8_ROWS: InspectResponseRow[] = [
  {
    key: "github-copilot/gemini-flash",
    displayName: "Gemini Flash (alias)",
    provider: "github-copilot",
    alias: "gemini-flash",
    strategy: "latest",
    status: "active",
    target: "gemini-2.5-flash",
    catalogID: "gemini-2.5-flash",
  },
  {
    key: "github-copilot/sonnet",
    displayName: "Sonnet (alias)",
    provider: "github-copilot",
    alias: "sonnet",
    strategy: "latest",
    status: "active",
    target: "claude-3-5-sonnet-20241022",
    catalogID: "claude-3-5-sonnet-20241022",
    wireModelID: "sonnet-4-exec",
  },
  {
    key: "openai/gpt-luna",
    displayName: "Custom GPT Luna",
    provider: "openai",
    alias: "gpt-luna",
    strategy: "latest",
    status: "active",
    target: "gpt-4o-mini-2024-07-18",
    catalogID: "gpt-4o-mini-2024-07-18",
  },
  {
    key: "openai/gpt-sol",
    displayName: "gpt-sol",
    provider: "openai",
    alias: "gpt-sol",
    strategy: "latest",
    status: "active",
    target: "o1-preview",
    catalogID: "o1-preview",
  },
  {
    key: "openai/gpt-terra",
    displayName: "GPT Terra (alias)",
    provider: "openai",
    alias: "gpt-terra",
    strategy: "latest",
    status: "active",
    target: "gpt-4o-2024-11-20",
    catalogID: "gpt-4o-2024-11-20",
  },
  {
    key: "opencode-go/deepseek-flash",
    displayName: "DeepSeek Flash (alias)",
    provider: "opencode-go",
    alias: "deepseek-flash",
    strategy: "latest",
    status: "active",
    target: "deepseek-v3-flash",
    catalogID: "deepseek-v3-flash",
  },
  {
    key: "opencode-go/glm-flash",
    displayName: "GLM Flash (alias)",
    provider: "opencode-go",
    alias: "glm-flash",
    strategy: "latest",
    status: "inactive",
    target: "glm-4-flash",
    catalogID: "glm-4-flash",
  },
  {
    key: "opencode-go/qwen-flash",
    displayName: "Qwen Flash (alias)",
    provider: "opencode-go",
    alias: "qwen-flash",
    strategy: "latest",
    status: "unresolved",
    failureKind: "no-eligible",
    failureReason: "no candidate matched pattern",
  },
];

function createStrictContext(options?: StrictContextOptions) {
  const notificationStorage =
    options?.notificationStorage ?? new Map<string, { aliases: Record<string, string> }>();
  const toasts: Array<{ title: string; message: string }> = [];
  const eventHandlers = new Set<(event: { location?: { directory: string } }) => void>();
  const registeredLayers: Array<() => KeymapLayer> = [];
  const returnedLayers: KeymapLayer[] = [];
  const activeCommands: KeymapCommand[] = [];
  const alerts: Array<{ title: string; message: string }> = [];
  const selectCalls: SelectCall[] = [];
  const inspectCalls: Array<{ input: unknown; options?: unknown }> = [];

  const defaultLoc = options?.defaultLocation ?? { directory: "/default/workspace" };
  let simulatedSelectReturn: string | undefined = options?.selectReturnValue;

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

  const inspectHandler =
    options?.inspectHandler ??
    (async () => ({
      text: "Report text",
      rows: [SAMPLE_ROW_ACTIVE],
    }));

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
    on: vi.fn((_type: string, handler: (event: { location?: { directory: string } }) => void) => {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    }),
    listen: vi.fn(),
  };

  const alertSpy = vi.fn(async (opts: { title: string; message: string }) => {
    alerts.push(opts);
  });

  const selectSpy = vi.fn(async (opts: SelectCall) => {
    selectCalls.push(opts);
    return simulatedSelectReturn;
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
      select: selectSpy,
      show: forbiddenProxy("ui.dialog.show"),
      set: forbiddenProxy("ui.dialog.set"),
      clear: forbiddenProxy("ui.dialog.clear"),
      confirm: forbiddenProxy("ui.dialog.confirm"),
      prompt: forbiddenProxy("ui.dialog.prompt"),
    },
    toast: {
      show: vi.fn((toast: { title: string; message: string }) => {
        toasts.push(toast);
      }),
    },
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
    storage: {
      store: (key: string, { initial }: { initial: { aliases: Record<string, string> } }) => {
        if (options?.storageFailure) throw new Error("private storage failure");
        const state = notificationStorage.get(key) ?? structuredClone(initial);
        notificationStorage.set(key, state);
        return [
          state,
          async (mutation: (draft: typeof state) => void) => {
            mutation(state);
          },
        ] as const;
      },
    },
    ui,
  };

  return {
    context: context as unknown as Plugin.Context,
    notificationStorage,
    toasts,
    emitModelUpdate: (location?: { directory: string }) => {
      for (const handler of eventHandlers) handler(location ? { location } : {});
    },
    eventHandlers,
    keymap,
    client,
    data,
    ui,
    alertSpy,
    selectSpy,
    defaultLocationSpy,
    slotImpl,
    alerts,
    selectCalls,
    inspectCalls,
    activeCommands,
    returnedLayers,
    setSelectReturn: (val: string | undefined) => {
      simulatedSelectReturn = val;
    },
    remountSlot: () => {
      activeCommands.length = 0;
      if (activeAppRender) {
        activeAppRender();
      }
    },
    isSlotDisposed: () => slotDisposed,
  };
}

describe("TUI slash and command palette registration", () => {
  it("registers a single command under slot append:app and keymap mode:global", () => {
    const harness = createStrictContext();
    plugin.setup(harness.context);

    expect(harness.slotImpl).toHaveBeenCalledTimes(1);
    expect(harness.returnedLayers).toHaveLength(1);
    expect(harness.returnedLayers[0]?.mode).toBe("global");
    expect(harness.activeCommands).toHaveLength(1);

    const command = harness.activeCommands[0];
    expect(command?.id).toBe("opencode-model-aliases.inspect");
    expect(command?.title).toBe("Model aliases");
    expect(command?.palette).toBe(true);
    expect(command?.slash).toEqual({
      name: "model-aliases",
      arguments: true,
    });
  });

  it("registers identically when the slot re-renders on catalog or theme update", () => {
    const harness = createStrictContext();
    plugin.setup(harness.context);

    expect(harness.activeCommands).toHaveLength(1);
    harness.remountSlot();
    expect(harness.activeCommands).toHaveLength(1);
    expect(harness.activeCommands[0]?.id).toBe("opencode-model-aliases.inspect");
  });

  it("unregisters command when the slot cleanup runs", async () => {
    const harness = createStrictContext();
    const cleanup = plugin.setup(harness.context);

    expect(harness.activeCommands).toHaveLength(1);
    if (typeof cleanup === "function") {
      await cleanup();
    }
    expect(harness.isSlotDisposed()).toBe(true);
    expect(harness.activeCommands).toHaveLength(0);
  });
});

describe("TUI dialog navigation: select list and detail view", () => {
  it("renders searchable native dialog.select with provider categories for actual 8 aliases", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: undefined, // Simulates cancellation
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.selectSpy).toHaveBeenCalledTimes(1);
    const call = harness.selectCalls[0];
    expect(call?.title).toBe("Model aliases");
    expect(call?.options).toHaveLength(8);

    // Provider category verification
    const categories = call?.options.map((o) => o.category);
    expect(categories).toEqual([
      "github-copilot",
      "github-copilot",
      "openai",
      "openai",
      "openai",
      "opencode-go",
      "opencode-go",
      "opencode-go",
    ]);

    // Compact title verification (no provider prefix)
    expect(call?.options.map((o) => o.title)).toEqual([
      "Gemini Flash (alias)",
      "Sonnet (alias)",
      "Custom GPT Luna",
      "gpt-sol",
      "GPT Terra (alias)",
      "DeepSeek Flash (alias)",
      "GLM Flash (alias)",
      "Qwen Flash (alias)",
    ]);

    // Verification of stable values (full keys)
    expect(call?.options.map((o) => o.value)).toEqual([
      "github-copilot/gemini-flash",
      "github-copilot/sonnet",
      "openai/gpt-luna",
      "openai/gpt-sol",
      "openai/gpt-terra",
      "opencode-go/deepseek-flash",
      "opencode-go/glm-flash",
      "opencode-go/qwen-flash",
    ]);

    // No active row carries a redundant (active) label
    const activeSonnet = call?.options.find((o) => o.value === "github-copilot/sonnet");
    expect(activeSonnet?.footer).toBeUndefined();

    // Problem rows mark their footer distinctively
    const inactiveGlm = call?.options.find((o) => o.value === "opencode-go/glm-flash");
    expect(inactiveGlm?.footer).toBe("inactive");

    const unresolvedQwen = call?.options.find((o) => o.value === "opencode-go/qwen-flash");
    expect(unresolvedQwen?.footer).toBe("unresolved");
    expect(unresolvedQwen?.description).toContain("no-eligible");

    // Cancelling the select is a no-op (no alert opens afterwards)
    expect(harness.alerts).toHaveLength(0);
  });

  it("seleccionar un alias abre el diálogo de detalle con canonical target y wire model ID si difiere", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: "github-copilot/sonnet",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.selectSpy).toHaveBeenCalledTimes(1);
    expect(harness.alertSpy).toHaveBeenCalledTimes(1);

    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: Sonnet (alias)");
    expect(alert?.message).toContain("Alias: github-copilot/sonnet");
    expect(alert?.message).toContain("Name: Sonnet (alias)");
    expect(alert?.message).toContain("Alias model ID: sonnet");
    expect(alert?.message).toContain("Target: github-copilot/claude-3-5-sonnet-20241022");
    expect(alert?.message).toContain("Wire model ID: sonnet-4-exec");
    expect(alert?.message).toContain("Strategy: latest");
    expect(alert?.message).toContain("Status: active");
  });

  it("seleccionar un alias sin wireID distinto no muestra la línea Wire model ID", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: "openai/gpt-terra",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: GPT Terra (alias)");
    expect(alert?.message).toContain("Alias: openai/gpt-terra");
    expect(alert?.message).toContain("Name: GPT Terra (alias)");
    expect(alert?.message).toContain("Alias model ID: gpt-terra");
    expect(alert?.message).toContain("Target: openai/gpt-4o-2024-11-20");
    expect(alert?.message).not.toContain("Wire model ID");
  });

  it("seleccionar un alias inactivo destaca su estado inactivo en el detalle", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: "opencode-go/glm-flash",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: GLM Flash (alias)");
    expect(alert?.message).toContain("Alias: opencode-go/glm-flash");
    expect(alert?.message).toContain("Name: GLM Flash (alias)");
    expect(alert?.message).toContain("Alias model ID: glm-flash");
    expect(alert?.message).toContain("Status: inactive (not in final catalog)");
  });

  it("seleccionar un alias sin resolver muestra fallo y razón detallada", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: "opencode-go/qwen-flash",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: Qwen Flash (alias)");
    expect(alert?.message).toContain("Alias: opencode-go/qwen-flash");
    expect(alert?.message).toContain("Name: Qwen Flash (alias)");
    expect(alert?.message).toContain("Alias model ID: qwen-flash");
    expect(alert?.message).toContain("Status: unresolved (no-eligible)");
    expect(alert?.message).toContain("Reason: no candidate matched pattern");
  });

  it("seleccionar un alias con nombre explícito muestra displayName en selector y detalle", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: "openai/gpt-luna",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: Custom GPT Luna");
    expect(alert?.message).toContain("Alias: openai/gpt-luna");
    expect(alert?.message).toContain("Name: Custom GPT Luna");
    expect(alert?.message).toContain("Alias model ID: gpt-luna");
    expect(alert?.message).toContain("Target: openai/gpt-4o-mini-2024-07-18");
  });

  it("omite la línea Alias model ID cuando displayName coincide con el alias model ID", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: SAMPLE_ACTUAL8_ROWS,
      }),
      selectReturnValue: "openai/gpt-sol",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: gpt-sol");
    expect(alert?.message).toContain("Alias: openai/gpt-sol");
    expect(alert?.message).toContain("Name: gpt-sol");
    expect(alert?.message).not.toContain("Alias model ID");
  });

  it("mantiene el key como valor estable de selección independientemente del displayName", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Summary text",
        rows: [
          {
            key: "provider-x/custom-slug",
            displayName: "Ultra Smart Model 5.0",
            provider: "provider-x",
            alias: "custom-slug",
            strategy: "latest",
            status: "active",
            target: "underlying-model-v5",
          },
        ],
      }),
      selectReturnValue: "provider-x/custom-slug",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    const call = harness.selectCalls[0];
    expect(call?.options[0]?.title).toBe("Ultra Smart Model 5.0");
    expect(call?.options[0]?.value).toBe("provider-x/custom-slug");

    const alert = harness.alerts[0];
    expect(alert?.title).toBe("Model aliases: Ultra Smart Model 5.0");
    expect(alert?.message).toContain("Alias: provider-x/custom-slug");
    expect(alert?.message).toContain("Name: Ultra Smart Model 5.0");
    expect(alert?.message).toContain("Alias model ID: custom-slug");
  });

  it("cuando no hay aliases configurados (rows:[]) abre alert nativo con el texto estático", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "No aliases configured.",
        rows: [],
      }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.selectSpy).not.toHaveBeenCalled();
    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    expect(harness.alerts[0]).toEqual({
      title: "Model aliases",
      message: "No aliases configured.",
    });
  });

  it("cuando el informe está indisponible (rows:[]) abre alert nativo breve con el texto estático", async () => {
    const harness = createStrictContext({
      inspectHandler: async () => ({
        text: "Model alias inspection is unavailable: the current alias mapping could not be confirmed against the final catalog.",
        rows: [],
      }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.selectSpy).not.toHaveBeenCalled();
    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
    expect(harness.alerts[0]?.message).toMatch(/unavailable/i);
  });
});

describe("TUI security, validation, and error boundaries", () => {
  it("strictly touches only inspection RPC, dialog.select and dialog.alert without forbidden APIs", async () => {
    const harness = createStrictContext({
      location: { directory: "/isolated" },
      inspectHandler: async () => ({
        text: "Aliases active:\n  sonnet -> sonnet-4",
        rows: [SAMPLE_ROW_ACTIVE],
      }),
      selectReturnValue: "github-copilot/sonnet",
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.inspectCalls).toHaveLength(2);
    expect(harness.selectSpy).toHaveBeenCalledTimes(1);
    expect(harness.alertSpy).toHaveBeenCalledTimes(1);
  });

  it("passes explicit location when context provides location", async () => {
    const harness = createStrictContext({
      location: { directory: "/custom/workdir" },
      inspectHandler: async () => ({ text: "ok", rows: [] }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.defaultLocationSpy).not.toHaveBeenCalled();
    expect(harness.inspectCalls[0]).toEqual({
      input: {},
      options: { location: { directory: "/custom/workdir" } },
    });
  });

  it("falls back to data.location.default() when context.location is omitted", async () => {
    const harness = createStrictContext({
      location: undefined,
      defaultLocation: { directory: "/fallback/default" },
      inspectHandler: async () => ({ text: "ok", rows: [] }),
    });
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run();

    expect(harness.defaultLocationSpy).toHaveBeenCalledTimes(2);
    expect(harness.inspectCalls[0]).toEqual({
      input: {},
      options: { location: { directory: "/fallback/default" } },
    });
  });

  it("rejects unexpected arguments via local usage dialog without calling RPC", async () => {
    const harness = createStrictContext();
    plugin.setup(harness.context);
    const command = harness.activeCommands[0];

    await command?.run("extra-argument");

    expect(harness.inspectCalls).toHaveLength(1); // Startup notification check only.
    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]?.title).toBe("Model aliases");
    expect(harness.alerts[0]?.message).toMatch(/unexpected arguments/i);

    await command?.run("  --flag  ");
    expect(harness.inspectCalls).toHaveLength(1); // Startup notification check only.
    expect(harness.alerts).toHaveLength(2);
  });

  it("displays grounded retry/reload advice dialog when response is malformed or rows invalid", async () => {
    for (const malformed of [
      null,
      undefined,
      {},
      { text: 123 },
      { text: "ok", rows: "not-an-array" },
      { text: "ok", rows: [{ invalid: "row" }] },
      { text: "ok", rows: [{ key: 123 }] },
      {
        text: "ok",
        rows: [
          {
            key: "github-copilot/sonnet",
            // missing required displayName
            provider: "github-copilot",
            alias: "sonnet",
            strategy: "latest",
            status: "active",
          },
        ],
      },
      {
        text: "ok",
        rows: [
          {
            key: "github-copilot/sonnet",
            displayName: 123,
            provider: "github-copilot",
            alias: "sonnet",
            strategy: "latest",
            status: "active",
          },
        ],
      },
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

  it("isInspectResponse rechaza filas sin displayName obligatorio o con tipo no string", () => {
    expect(
      isInspectResponse({
        text: "ok",
        rows: [
          {
            key: "github-copilot/sonnet",
            // missing displayName
            provider: "github-copilot",
            alias: "sonnet",
            strategy: "latest",
            status: "active",
          },
        ],
      }),
    ).toBe(false);

    expect(
      isInspectResponse({
        text: "ok",
        rows: [
          {
            key: "github-copilot/sonnet",
            displayName: null,
            provider: "github-copilot",
            alias: "sonnet",
            strategy: "latest",
            status: "active",
          },
        ],
      }),
    ).toBe(false);

    expect(
      isInspectResponse({
        text: "ok",
        rows: [
          {
            key: "github-copilot/sonnet",
            displayName: "Sonnet (alias)",
            provider: "github-copilot",
            alias: "sonnet",
            strategy: "latest",
            status: "active",
          },
        ],
      }),
    ).toBe(true);
  });

  it("formatDetailMessage preserva Alias: {key}, incluye Name: {displayName} y condiciona Alias model ID", () => {
    const withDifferentName: InspectResponseRow = {
      key: "anthropic/my-alias",
      displayName: "Claude Sonnet (alias)",
      provider: "anthropic",
      alias: "my-alias",
      strategy: "latest",
      status: "active",
      target: "claude-3-7-sonnet",
    };
    const formattedDifferent = formatDetailMessage(withDifferentName);
    expect(formattedDifferent).toContain("Alias: anthropic/my-alias");
    expect(formattedDifferent).toContain("Name: Claude Sonnet (alias)");
    expect(formattedDifferent).toContain("Alias model ID: my-alias");

    const withMatchingName: InspectResponseRow = {
      key: "anthropic/my-alias",
      displayName: "my-alias",
      provider: "anthropic",
      alias: "my-alias",
      strategy: "latest",
      status: "active",
      target: "claude-3-7-sonnet",
    };
    const formattedMatching = formatDetailMessage(withMatchingName);
    expect(formattedMatching).toContain("Alias: anthropic/my-alias");
    expect(formattedMatching).toContain("Name: my-alias");
    expect(formattedMatching).not.toContain("Alias model ID");
  });
});

describe("TUI change notifications", () => {
  const transition = (id = "transition-1") => ({
    id,
    from: "github-copilot/sonnet-old",
    to: "github-copilot/sonnet-new",
    fromWireModelID: "sonnet-old",
    toWireModelID: "sonnet-new",
    changedAt: "2026-10-06T12:00:00.000Z",
  });
  it("shows changes once, persists acknowledgement across restarts, and keeps detail available", async () => {
    let row: InspectResponseRow = SAMPLE_ROW_ACTIVE;
    const response = async () => ({ text: "ok", rows: [row] });
    const first = createStrictContext({
      inspectHandler: response,
      location: { directory: "/project" },
    });
    const close = plugin.setup(first.context);
    await vi.waitFor(() => expect(first.notificationStorage.size).toBe(1));
    expect(first.toasts).toHaveLength(0);
    row = { ...SAMPLE_ROW_ACTIVE, transition: transition() };
    first.emitModelUpdate({ directory: "/unrelated" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.toasts).toHaveLength(0);
    first.emitModelUpdate({ directory: "/project" });
    await vi.waitFor(() => expect(first.toasts).toHaveLength(1));
    expect(first.toasts[0]?.message).toContain("sonnet-old → github-copilot/sonnet-new");
    first.emitModelUpdate();
    await first.activeCommands[0]?.run();
    expect(first.toasts).toHaveLength(1);
    if (typeof close === "function") await close();
    expect(first.eventHandlers.size).toBe(0);
    const restarted = createStrictContext({
      inspectHandler: response,
      location: { directory: "/project" },
      notificationStorage: first.notificationStorage,
    });
    plugin.setup(restarted.context);
    await vi.waitFor(() => expect(restarted.inspectCalls).toHaveLength(1));
    await restarted.activeCommands[0]?.run();
    expect(restarted.toasts).toHaveLength(0);
    expect(formatDetailMessage(row)).toContain("Detected: 2026-10-06T12:00:00.000Z");
  });

  it("lets already open clients show a transition independently and groups multiple changes", async () => {
    let change: ReturnType<typeof transition> | undefined;
    const shared = new Map<string, { aliases: Record<string, string> }>();
    const response = async () => ({
      text: "ok",
      rows: [
        { ...SAMPLE_ROW_ACTIVE, ...(change ? { transition: change } : {}) },
        {
          ...SAMPLE_ROW_ACTIVE,
          key: "github-copilot/other",
          ...(change ? { transition: { ...change, id: "other-id" } } : {}),
        },
      ],
    });
    const first = createStrictContext({ inspectHandler: response, notificationStorage: shared });
    const second = createStrictContext({ inspectHandler: response, notificationStorage: shared });
    plugin.setup(first.context);
    plugin.setup(second.context);
    await vi.waitFor(() => expect(shared.size).toBe(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    change = transition();
    first.emitModelUpdate();
    await vi.waitFor(() => expect(first.toasts).toHaveLength(1));
    second.emitModelUpdate();
    await vi.waitFor(() => expect(second.toasts).toHaveLength(1));
    expect(first.toasts[0]?.message).toContain("github-copilot/other");
  });

  it("ignores malformed/inactive history and contains notification storage failures", async () => {
    expect(
      isInspectResponse({ text: "ok", rows: [{ ...SAMPLE_ROW_ACTIVE, transition: { id: 1 } }] }),
    ).toBe(false);
    const inactive = createStrictContext({
      inspectHandler: async () => ({
        text: "ok",
        rows: [{ ...SAMPLE_ROW_ACTIVE, status: "inactive", transition: transition() }],
      }),
    });
    plugin.setup(inactive.context);
    await inactive.activeCommands[0]?.run();
    expect(inactive.toasts).toHaveLength(0);
    const failure = createStrictContext({
      storageFailure: true,
      inspectHandler: async () => ({
        text: "ok",
        rows: [{ ...SAMPLE_ROW_ACTIVE, transition: transition() }],
      }),
    });
    plugin.setup(failure.context);
    await failure.activeCommands[0]?.run();
    expect(failure.toasts).toHaveLength(0);
    expect(failure.selectSpy).toHaveBeenCalledTimes(1);
    expect(failure.alerts).toHaveLength(0);
  });
});
