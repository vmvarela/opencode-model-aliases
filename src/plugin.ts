import { type Model, Plugin } from "@opencode/plugin";
import {
  isPlainObject,
  type NormalizedAlias,
  type NormalizedConfig,
  type Options,
} from "./config.js";
import { loadConfigFile } from "./config-file.js";
import { normalizeOptions } from "./normalize.js";
import { resolveLatest } from "./resolve.js";

const PLUGIN_ID = "opencode-floating-models";
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
 */
function replay(config: NormalizedConfig, editor: FloatingEditor): void {
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

    const registration = await ctx.model.transform((hostEditor) => {
      try {
        // Límite único host→adaptador: DeepMutable del host degrada los strings
        // con brand; aquí se adapta a la vista limpia del editor.
        replay(normalized.config, hostEditor as unknown as FloatingEditor);
      } catch (error) {
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
    return async () => {
      await registration.dispose();
    };
  },
});
