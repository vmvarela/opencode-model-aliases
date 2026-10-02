import { type Model, Plugin } from "@opencode/plugin";
import {
  isPlainObject,
  type NormalizedAlias,
  type NormalizedConfig,
  type Options,
} from "./config.js";
import { loadConfigFile } from "./config-file.js";
import { normalizeOptions } from "./normalize.js";
import { type AliasReportRow, buildRows, formatReport, UNAVAILABLE_REPORT } from "./report.js";
import { resolveLatest } from "./resolve.js";
import { ModelAliasesRpc } from "./rpc.js";

const PLUGIN_ID = "opencode-model-aliases";
const LOG_PREFIX = `[${PLUGIN_ID}]`;
const FLOATING_SUFFIX = " (floating)";

type ModelInfo = Model.Info;

/**
 * Editor mínimo que el adaptador necesita del transform v2. La declaración
 * real del host envuelve los campos en DeepMutable y degrada los strings con
 * brand; el límite de registro convierte al editor del host a esta vista.
 */
interface FloatingEditor {
  list(): readonly ModelInfo[];
  update(providerID: string, modelID: string, update: (model: ModelInfo) => void): void;
}

/**
 * Nombre visible por defecto, determinista a partir del modelID del alias
 * (último segmento, separadores como espacios, primera letra mayúscula):
 * "sonnet" → "Sonnet (floating)". El name configurado se usa intacto.
 */
function defaultAliasName(modelID: string): string {
  const segment = modelID.split("/").pop() ?? "";
  const label = segment
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return `${label}${FLOATING_SUFFIX}`;
}

function displayName(alias: NormalizedAlias): string {
  return alias.nameExplicit ? alias.name : defaultAliasName(alias.modelID);
}

/**
 * Una repetición del transform. Según la semántica v2, cada repetición parte
 * del catálogo fuente fresco (sin salida de repeticiones previas): snapshot
 * una vez, colisión verificada contra ese snapshot, resolución única por
 * alias y materialización. Ningún alias alimenta a otro.
 *
 * Devuelve las filas de informe construidas de los MISMOS resultados de
 * resolución usados para materializar; el llamador solo las publica si la
 * repetición completa (incluida la materialización) tuvo éxito.
 */
function replay(config: NormalizedConfig, editor: FloatingEditor): AliasReportRow[] {
  const snapshot = editor.list();

  // Colisión de configuración: el id del alias ya existe como modelo fuente.
  // Fatal siempre, independientemente de `strict` o de que el alias resuelva.
  for (const alias of config.aliases) {
    const preexisting = snapshot.some(
      (model) => model.providerID === alias.provider && model.id === alias.modelID,
    );
    if (preexisting) {
      throw new Error(
        `${LOG_PREFIX} configuration collision: alias "${alias.key}" would overwrite existing model "${alias.provider}/${alias.modelID}"`,
      );
    }
  }

  // Una sola resolución por alias; la misma decisión sirve para el preflight
  // strict y para materializar.
  const results = config.aliases.map((alias) => ({
    alias,
    result: resolveLatest(snapshot, alias),
  }));

  if (config.strict) {
    const parts: string[] = [];
    for (const { alias, result } of results) {
      if (!result.ok) parts.push(`${alias.key} (${result.failure.kind})`);
    }
    if (parts.length > 0) {
      throw new Error(
        `${LOG_PREFIX} strict: unresolved aliases before materialization: ${parts.join(", ")}`,
      );
    }
  }

  for (const { alias, result } of results) {
    if (!result.ok) {
      // Tolerante: avisar y omitir solo este alias; los demás siguen.
      console.warn(
        `${LOG_PREFIX} alias "${alias.key}" unresolved (${result.failure.kind}): ${result.failure.reason}`,
      );
      continue;
    }
    const { model: winner, stages } = result;
    const label = displayName(alias);
    editor.update(alias.provider, alias.modelID, (model) => {
      const clone = structuredClone(winner);
      // Solo id y name cambian; el resto del Model.Info del ganador se hereda.
      const patchable = clone as { id: string; name: string };
      patchable.id = alias.modelID;
      patchable.name = label;
      Object.assign(model, clone);
    });
    if (config.debug) {
      const [matching, filtering] = stages;
      // El host v2.0.22 traga console.debug/console.log de los plugins, así que
      // el diagnóstico de depuración usa console.warn con prefijo [debug]: los
      // mensajes solo contienen metadatos públicos del modelo (id, recuentos,
      // timestamp), nunca options/headers/credenciales ni prompts.
      console.warn(
        `${LOG_PREFIX} [debug] alias "${alias.key}" -> ${alias.provider}/${winner.modelID}` +
          ` (strategy=latest, matched=${matching?.accepted ?? 0}, eligible=${filtering?.accepted ?? 0},` +
          ` released=${winner.time.released})`,
      );
    }
  }

  return buildRows(results);
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    // Carga del archivo de configuración más cercano, ANTES de registrar
    // cualquier transform: un fallo de lectura/parseo/fusión deja cero
    // transforms registrados.
    const loaded = await loadConfigFile(ctx.location.directory);
    if (!loaded.ok) {
      throw new Error(`${LOG_PREFIX} invalid configuration: ${loaded.reason}`);
    }
    const fileOptions = loaded.file?.options;

    // Entrada no confiable; se fusiona con el archivo como base y los valores
    // inline del host con prioridad. La validación completa ocurre en
    // normalizeOptions sobre el resultado fusionado.
    const inline = ctx.options as unknown;
    if (inline !== undefined && inline !== null && !isPlainObject(inline)) {
      throw new Error(`${LOG_PREFIX} invalid configuration: options must be an object`);
    }
    const inlineOptions = isPlainObject(inline) ? inline : {};

    const merged: Record<string, unknown> = {};
    for (const key of ["strict", "debug"] as const) {
      // El valor inline, si fue suministrado (incluso `false`), gana al archivo.
      if (inlineOptions[key] !== undefined) {
        merged[key] = inlineOptions[key];
      } else if (fileOptions?.[key] !== undefined) {
        merged[key] = fileOptions[key];
      }
    }

    // Union por clave: un registro inline reemplaza el AliasConfig completo
    // del archivo para esa clave (sin fusión parcial). Los contenedores de
    // cada fuente ya fueron validados; un contenedor inline inválido falla
    // aquí en vez de extenderse silenciosamente en el mapa.
    const inlineAliases = inlineOptions.aliases;
    if (inlineAliases !== undefined && !isPlainObject(inlineAliases)) {
      throw new Error(
        `${LOG_PREFIX} invalid configuration: aliases must be an object ({} is a valid no-op)`,
      );
    }
    if (fileOptions?.aliases !== undefined || inlineAliases !== undefined) {
      merged.aliases = {
        ...fileOptions?.aliases,
        ...(isPlainObject(inlineAliases) ? inlineAliases : {}),
      };
    }

    const normalized = normalizeOptions(merged as unknown as Options);
    if (!normalized.ok) {
      throw new Error(`${LOG_PREFIX} invalid configuration: ${normalized.failure.reason}`);
    }

    // El host v2 traga las excepciones de los transform (State.get captura,
    // deshabilita el plugin y reconstruye el estado), de modo que la primera
    // ctx.model.list() puede resolver con éxito tras un fallo. Capturamos el
    // primer error solo durante la lectura inicial forzada y lo relanzamos:
    // el rethrow mantiene el rollback del grupo y, si el host lo tragó,
    // el setup falla explícitamente.
    let initializing = true;
    let hasInitialError = false;
    let initialError: unknown;

    // Snapshot de informe del setup (cierre pequeño, solo primitivas):
    // null significa indisponibilidad — la última repetición falló y no hay
    // mapeo actual descibible. Se reemplaza una vez por repetición, solo si
    // toda la repetición/materialización tuvo éxito; ante cualquier fallo se
    // limpia para no describir mapeos parciales ni stale como actuales.
    let reportRows: readonly AliasReportRow[] | null = null;

    const registration = await ctx.model.transform((hostEditor) => {
      try {
        // Límite único host→adaptador: DeepMutable del host degrada los strings
        // con brand; aquí se adapta a la vista limpia del editor.
        const rows = replay(normalized.config, hostEditor as unknown as FloatingEditor);
        reportRows = rows;
      } catch (error) {
        reportRows = null;
        if (initializing && !hasInitialError) {
          hasInitialError = true;
          initialError = error;
        }
        throw error;
      }
    });

    try {
      await ctx.model.list();
    } catch (error) {
      initializing = false;
      await registration.dispose();
      throw error;
    }
    if (hasInitialError) {
      initializing = false;
      await registration.dispose();
      throw initialError;
    }
    initializing = false;

    // Único RPC del plugin, registrado tras la inicialización exitosa. El
    // handler NO vuelve a resolver ni consulta APIs de proveedor/sesión para
    // inspeccionar: primero sincroniza el registro con ctx.model.list() (que
    // además revela si un refresco falló) y después lee el snapshot publicado
    // por el transform, verificando contra el catálogo final la identidad de
    // cada alias resuelto (una política posterior puede retirar, deshabilitar
    // o reescribir el modelID de ejecución del alias materializado).
    let rpcRegistration: { dispose: () => Promise<void> };
    try {
      rpcRegistration = await ctx.rpc.register(ModelAliasesRpc, {
        inspect: async () => {
          // Vista mínima del catálogo final; solo primitivas de identidad
          // (proveedor, id, modelID de ejecución y enabled). Sin objetos
          // Model.Info completos, settings, headers ni credenciales.
          let catalog: ReadonlyArray<{
            providerID: string;
            id: string;
            modelID?: string;
            enabled?: boolean;
          }>;
          try {
            catalog = (await ctx.model.list()).data;
          } catch {
            // El refresco falló: ni el snapshot previo ni uno parcial; texto de
            // indisponibilidad.
            return { text: UNAVAILABLE_REPORT };
          }
          const snapshot = reportRows;
          if (snapshot === null) {
            return { text: UNAVAILABLE_REPORT };
          }
          // Visibilidad final por primitivas: un alias deshabilitado por una
          // política posterior no se etiqueta como activo; un alias retirado
          // conserva el comportamiento existente (inactive).
          const wire = new Map<string, string | undefined>();
          const visible = new Set<string>();
          for (const model of catalog) {
            const entry = `${model.providerID}/${model.id}`;
            wire.set(entry, model.modelID);
            if (model.enabled !== false) visible.add(entry);
          }
          // Guardia de identidad: si el alias sigue habilitado pero una
          // política posterior cambió su modelID de ejecución respecto del
          // seleccionado, el snapshot ya no describe el mapeo real. En vez de
          // adivinar o mostrar el objetivo viejo como activo, informe
          // indisponible completo (caso raro de política en conflicto).
          for (const row of snapshot) {
            if (row.status !== "resolved" || !visible.has(row.key)) continue;
            const selected = row.wireModelID ?? row.catalogID;
            if (wire.get(row.key) !== selected) {
              return { text: UNAVAILABLE_REPORT };
            }
          }
          return { text: formatReport(snapshot, visible) };
        },
      });
    } catch (error) {
      // El modelo ya está registrado: si el RPC no pudo registrarse, el setup
      // rechaza dejando cero recursos vivos.
      await registration.dispose();
      throw error;
    }

    return async () => {
      // Limpieza en orden inverso al registro: primero el RPC, luego el
      // transform. Ambos dispose son idempotentes.
      await rpcRegistration.dispose();
      await registration.dispose();
    };
  },
});
