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

interface ConfirmCall {
  title: string;
  message: string;
  label?: { confirm?: string; cancel?: string };
}

interface StrictContextOptions {
  notificationStorage?: Map<string, { aliases: Record<string, string> }>;
  storageFailure?: boolean;
  saveNotification?: () => Promise<void>;
  location?: { directory: string } | undefined;
  defaultLocation?: { directory: string } | undefined;
  explainHandler?: (input: unknown, options?: { location?: unknown }) => Promise<unknown>;
  inspectHandler?:
    | ((
        input: Record<string, never>,
        options?: { location?: unknown } | undefined,
      ) => Promise<unknown>)
    | undefined;
  selectReturnValue?: string | undefined | (() => string | undefined);
  confirmReturnValue?: boolean | undefined | (() => boolean | undefined);
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
  const confirms: ConfirmCall[] = [];
  const selectCalls: SelectCall[] = [];
  const inspectCalls: Array<{ input: unknown; options?: unknown }> = [];

  const defaultLoc = options?.defaultLocation ?? { directory: "/default/workspace" };
  let simulatedSelectReturn = options?.selectReturnValue;
  let simulatedConfirmReturn = options?.confirmReturnValue;

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
        explain: vi.fn(async (input: unknown, rpcOptions?: { location?: unknown }) => {
          return options?.explainHandler?.(input, rpcOptions) ?? { status: "unknown-alias" };
        }),
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

  const confirmSpy = vi.fn(async (opts: ConfirmCall) => {
    confirms.push(opts);
    return typeof simulatedConfirmReturn === "function"
      ? simulatedConfirmReturn()
      : simulatedConfirmReturn;
  });

  const selectSpy = vi.fn(async (opts: SelectCall) => {
    selectCalls.push(opts);
    return typeof simulatedSelectReturn === "function"
      ? simulatedSelectReturn()
      : simulatedSelectReturn;
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
      confirm: confirmSpy,
      select: selectSpy,
      show: forbiddenProxy("ui.dialog.show"),
      set: forbiddenProxy("ui.dialog.set"),
      clear: forbiddenProxy("ui.dialog.clear"),
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
            await options?.saveNotification?.();
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
    confirms,
    confirmSpy,
    selectCalls,
    inspectCalls,
    activeCommands,
    returnedLayers,
    setConfirmReturn: (val: boolean | undefined | (() => boolean | undefined)) => {
      simulatedConfirmReturn = val;
    },
    setSelectReturn: (val: string | undefined | (() => string | undefined)) => {
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
    expect(harness.confirmSpy).not.toHaveBeenCalled();
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

    expect(harness.defaultLocationSpy).toHaveBeenCalled();
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

  it("retries failed acknowledgements without showing the toast again", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(undefined);
    const response = async () => ({
      text: "ok",
      rows: [{ ...SAMPLE_ROW_ACTIVE, transition: transition() }],
    });
    const first = createStrictContext({ inspectHandler: response, saveNotification: save });
    const close = plugin.setup(first.context);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    first.emitModelUpdate();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(first.toasts).toHaveLength(1);
    if (typeof close === "function") await close();
    const restarted = createStrictContext({
      inspectHandler: response,
      notificationStorage: first.notificationStorage,
    });
    const stop = plugin.setup(restarted.context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(restarted.toasts).toHaveLength(0);
    if (typeof stop === "function") await stop();
  });

  it("discards a notification response when the active location changed while awaiting RPC", async () => {
    let reply!: (value: unknown) => void;
    const host = createStrictContext({
      inspectHandler: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    const stop = plugin.setup(host.context);
    await vi.waitFor(() => expect(host.inspectCalls).toHaveLength(1));
    host.defaultLocationSpy.mockReturnValue({ directory: "/different-project" });
    reply({ text: "ok", rows: [{ ...SAMPLE_ROW_ACTIVE, transition: transition() }] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host.toasts).toHaveLength(0);
    if (typeof stop === "function") await stop();
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

describe("TUI explain action", () => {
  it("renders interactive dialog.select with overview and candidates grouped by outcome", async () => {
    const explainHandler = vi.fn(async () => ({
      status: "active",
      explanation: {
        alias: "p/alias",
        strategy: "latest",
        unmatched: 3,
        stages: [
          { name: "matching", accepted: 2 },
          { name: "filtering", accepted: 2 },
          { name: "selection", accepted: 1 },
        ],
        winner: "p/winner",
        candidates: [
          {
            id: "p/winner",
            matchedPatterns: ["p/*"],
            outcome: "selected",
            stage: "selection",
            released: 2000,
            reasons: [{ code: "newest-release", message: "Newest eligible candidate" }],
          },
          {
            id: "p/older",
            matchedPatterns: ["p/*"],
            outcome: "eligible",
            stage: "selection",
            released: 1000,
            reasons: [
              { code: "older-release", message: "Older release than the selected candidate" },
            ],
          },
          {
            id: "p/rejected",
            matchedPatterns: ["p/*"],
            outcome: "rejected",
            stage: "filtering",
            reasons: [{ code: "requirement-not-met", message: "Does not satisfy minContext>=100" }],
          },
        ],
      },
    }));
    const location = { directory: "/project" };
    const harness = createStrictContext({ explainHandler, location });
    const stop = plugin.setup(harness.context);
    await harness.activeCommands[0]?.run(" explain p/alias ");
    expect(explainHandler).toHaveBeenCalledWith({ alias: "p/alias" }, { location });
    expect(harness.selectCalls).toHaveLength(1);
    const call = harness.selectCalls[0];
    expect(call?.title).toBe("Model alias explanation: p/alias");
    expect(call?.placeholder).toBe("Filter candidates...");
    expect(call?.options).toEqual([
      {
        category: "overview",
        title: "Overview",
        description: "match: 2 → filter: 2 → select: 1",
        footer: "active",
        value: "__overview__",
      },
      {
        category: "selected",
        title: "winner",
        footer: undefined,
        value: "p/winner",
      },
      {
        category: "eligible",
        title: "older",
        footer: undefined,
        value: "p/older",
      },
      {
        category: "rejected",
        title: "rejected",
        footer: "filtering",
        value: "p/rejected",
      },
    ]);
    expect(harness.alerts).toHaveLength(0);
    await stop?.();
  });

  it("enforces narrow-row information policy for small terminals", async () => {
    const explainHandler = vi.fn(async () => ({
      status: "active",
      explanation: {
        alias: "opencode/zen-plan",
        strategy: "latest",
        unmatched: 3,
        stages: [
          { name: "matching", accepted: 9 },
          { name: "filtering", accepted: 9 },
          { name: "selection", accepted: 1 },
        ],
        winner: "opencode/longcat-2.5-preview-free",
        candidates: [
          {
            id: "opencode/longcat-2.5-preview-free",
            matchedPatterns: ["opencode/*-free"],
            outcome: "selected",
            stage: "selection",
            released: 1700000000000,
            reasons: [
              {
                code: "newest-release",
                message: "Newest eligible candidate with a reliable release timestamp",
              },
            ],
          },
          {
            id: "opencode/muse-spark-1.3-contributor-free",
            matchedPatterns: ["opencode/*-free"],
            outcome: "eligible",
            stage: "selection",
            released: 1600000000000,
            reasons: [
              { code: "older-release", message: "Older release than the selected candidate" },
            ],
          },
          {
            id: "opencode/exo-free",
            matchedPatterns: ["opencode/*-free"],
            outcome: "rejected",
            stage: "matching",
            reasons: [{ code: "excluded-pattern", message: "Excluded by opencode/exo-*" }],
          },
          {
            id: "opencode/mimo-v2.6-flash-free",
            matchedPatterns: ["opencode/*-free"],
            outcome: "rejected",
            stage: "filtering",
            reasons: [
              { code: "requirement-not-met", message: "Does not satisfy minContext>=256000" },
            ],
          },
        ],
      },
    }));
    const harness = createStrictContext({
      explainHandler,
      selectReturnValue: "opencode/mimo-v2.6-flash-free",
    });
    const stop = plugin.setup(harness.context);
    await harness.activeCommands[0]?.run("explain opencode/zen-plan");
    expect(harness.selectCalls).toHaveLength(1);
    const call = harness.selectCalls[0];

    // Overview: compact title and stage names, preserves status footer
    const overview = call?.options.find((o) => o.value === "__overview__");
    expect(overview?.title).toBe("Overview");
    expect(overview?.description).toBe("match: 9 → filter: 9 → select: 1");
    expect(overview?.footer).toBe("active");

    // Candidates: strip provider prefix for compact title
    expect(call?.options.map((o) => o.title)).toEqual([
      "Overview",
      "longcat-2.5-preview-free",
      "muse-spark-1.3-contributor-free",
      "exo-free",
      "mimo-v2.6-flash-free",
    ]);

    // Candidates: no reason descriptions in rows to avoid horizontal clipping
    const candidateOptions = call?.options.filter((o) => o.value !== "__overview__");
    expect(candidateOptions?.every((o) => o.description === undefined)).toBe(true);

    // Candidates: non-rejected rows omit footers; rejected rows show only stage
    const selectedOpt = call?.options.find((o) => o.value === "opencode/longcat-2.5-preview-free");
    expect(selectedOpt?.footer).toBeUndefined();
    const eligibleOpt = call?.options.find(
      (o) => o.value === "opencode/muse-spark-1.3-contributor-free",
    );
    expect(eligibleOpt?.footer).toBeUndefined();
    const rejectedMatching = call?.options.find((o) => o.value === "opencode/exo-free");
    expect(rejectedMatching?.footer).toBe("matching");
    const rejectedFiltering = call?.options.find(
      (o) => o.value === "opencode/mimo-v2.6-flash-free",
    );
    expect(rejectedFiltering?.footer).toBe("filtering");

    // Detail confirm dialog preserves full canonical ID, full reasons, and navigation labels
    expect(harness.confirms.at(-1)?.title).toBe("Candidate: opencode/mimo-v2.6-flash-free");
    expect(harness.confirms.at(-1)?.message).toContain(
      "✗ opencode/mimo-v2.6-flash-free (rejected)",
    );
    expect(harness.confirms.at(-1)?.message).toContain("Does not satisfy minContext>=256000");
    expect(harness.confirms.at(-1)?.label).toEqual({
      confirm: "Back to candidates",
      cancel: "Exit",
    });

    await stop?.();
  });

  it("opens candidate detail or overview confirm dialog when selected from dialog", async () => {
    const explainHandler = vi.fn(async () => ({
      status: "active",
      explanation: {
        alias: "p/alias",
        strategy: "latest",
        unmatched: 3,
        stages: [
          { name: "matching", accepted: 1 },
          { name: "filtering", accepted: 1 },
          { name: "selection", accepted: 1 },
        ],
        winner: "p/model",
        candidates: [
          {
            id: "p/model",
            matchedPatterns: ["p/*"],
            outcome: "selected",
            stage: "selection",
            released: 1000,
            reasons: [{ code: "newest-release", message: "Newest eligible candidate" }],
          },
        ],
      },
    }));
    const harness = createStrictContext({ explainHandler, selectReturnValue: "p/model" });
    const stop = plugin.setup(harness.context);
    await harness.activeCommands[0]?.run("explain p/alias");
    expect(harness.confirms.at(-1)?.title).toBe("Candidate: p/model");
    expect(harness.confirms.at(-1)?.message).toContain("✓ p/model (selected)");
    expect(harness.confirms.at(-1)?.message).toContain("Newest eligible candidate");
    expect(harness.confirms.at(-1)?.label).toEqual({
      confirm: "Back to candidates",
      cancel: "Exit",
    });

    harness.setSelectReturn("__overview__");
    await harness.activeCommands[0]?.run("explain p/alias");
    expect(harness.confirms.at(-1)?.title).toBe("Model alias explanation: p/alias");
    expect(harness.confirms.at(-1)?.message).toContain("matching: 1 → filtering: 1 → selection: 1");
    expect(harness.confirms.at(-1)?.message).toContain("Winner: p/model");
    expect(harness.confirms.at(-1)?.label).toEqual({
      confirm: "Back to candidates",
      cancel: "Exit",
    });
    await stop?.();
  });

  it("returns to candidate list on Enter/confirm and exits on Escape/cancel", async () => {
    const explainHandler = vi.fn(async () => ({
      status: "active",
      explanation: {
        alias: "p/alias",
        strategy: "latest",
        unmatched: 1,
        stages: [
          { name: "matching", accepted: 2 },
          { name: "filtering", accepted: 2 },
          { name: "selection", accepted: 1 },
        ],
        winner: "p/m1",
        candidates: [
          {
            id: "p/m1",
            matchedPatterns: ["p/*"],
            outcome: "selected",
            stage: "selection",
            released: 2000,
            reasons: [{ code: "newest-release", message: "Newest eligible candidate" }],
          },
          {
            id: "p/m2",
            matchedPatterns: ["p/*"],
            outcome: "eligible",
            stage: "selection",
            released: 1000,
            reasons: [{ code: "older-release", message: "Older release" }],
          },
        ],
      },
    }));

    // Sequence:
    // 1st select: "p/m1" -> confirm returns true (Enter/Back)
    // 2nd select: "p/m2" -> confirm returns false (Escape/Exit)
    const selectSequence = ["p/m1", "p/m2"];
    const confirmSequence = [true, false];
    const harness = createStrictContext({
      explainHandler,
      selectReturnValue: () => selectSequence.shift(),
      confirmReturnValue: () => confirmSequence.shift(),
    });
    const stop = plugin.setup(harness.context);

    await harness.activeCommands[0]?.run("explain p/alias");

    // 2 select calls because 1st confirmed (looped back), and 2nd canceled (exited)
    expect(harness.selectCalls).toHaveLength(2);
    expect(harness.confirms).toHaveLength(2);
    expect(harness.confirms[0]?.title).toBe("Candidate: p/m1");
    expect(harness.confirms[1]?.title).toBe("Candidate: p/m2");

    await stop?.();
  });

  it("exits on Escape from initial candidate list without opening confirm", async () => {
    const explainHandler = vi.fn(async () => ({
      status: "active",
      explanation: {
        alias: "p/alias",
        strategy: "latest",
        unmatched: 0,
        stages: [{ name: "matching", accepted: 1 }],
        winner: "p/m1",
        candidates: [
          {
            id: "p/m1",
            matchedPatterns: ["p/*"],
            outcome: "selected",
            stage: "selection",
            reasons: [],
          },
        ],
      },
    }));
    const harness = createStrictContext({ explainHandler, selectReturnValue: undefined });
    const stop = plugin.setup(harness.context);

    await harness.activeCommands[0]?.run("explain p/alias");

    expect(harness.selectCalls).toHaveLength(1);
    expect(harness.confirms).toHaveLength(0);
    expect(harness.alerts).toHaveLength(0);

    await stop?.();
  });

  it("renders short alert directly when candidate list is empty", async () => {
    const explainHandler = vi.fn(async () => ({
      status: "unresolved",
      explanation: {
        alias: "p/alias",
        strategy: "latest",
        unmatched: 0,
        stages: [{ name: "matching", accepted: 0 }],
        failure: { stage: "matching", code: "no-candidates", message: "no candidate matched" },
        candidates: [],
      },
    }));
    const harness = createStrictContext({ explainHandler });
    const stop = plugin.setup(harness.context);
    await harness.activeCommands[0]?.run("explain p/alias");
    expect(harness.selectCalls).toHaveLength(0);
    expect(harness.alerts.at(-1)?.title).toBe("Model alias explanation");
    expect(harness.alerts.at(-1)?.message).toContain("Failed at matching: no candidate matched");
    await stop?.();
  });

  it("rejects invalid syntax locally and handles unknown, unavailable, malformed and failed RPC", async () => {
    const explainHandler = vi.fn(async (): Promise<unknown> => ({ status: "unknown-alias" }));
    const harness = createStrictContext({ explainHandler });
    const stop = plugin.setup(harness.context);
    for (const input of ["explain", "explain p/a extra", "reload"])
      await harness.activeCommands[0]?.run(input);
    expect(explainHandler).not.toHaveBeenCalled();
    await harness.activeCommands[0]?.run("explain p/a");
    expect(harness.alerts.at(-1)?.message).toContain("Unknown alias");
    explainHandler.mockResolvedValueOnce({ status: "unavailable" });
    await harness.activeCommands[0]?.run("explain p/a");
    expect(harness.alerts.at(-1)?.message).toContain("unavailable");
    explainHandler.mockResolvedValueOnce({ status: "active", explanation: {} });
    await harness.activeCommands[0]?.run("explain p/a");
    expect(harness.alerts.at(-1)?.message).toContain("Unable to load");
    explainHandler.mockRejectedValueOnce(new Error("PRIVATE"));
    await harness.activeCommands[0]?.run("explain p/a");
    expect(harness.alerts.at(-1)?.message).not.toContain("PRIVATE");
    await stop?.();
  });
});
