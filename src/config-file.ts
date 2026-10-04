import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { isPlainObject } from "./config.js";

/** Directorio + nombre del archivo de configuración del plugin. */
const CONFIG_DIR = ".opencode";
const FILE_NAME = "opencode-model-aliases.jsonc";

/** Options crudas leídas del archivo; los valores aún no están validados.
 *  Las claves raíz no reconocidas se preservan tal cual: normalizeOptions
 *  debe rechazarlas como parse-error (sin whitelisting silencioso). */
export interface RawFileOptions {
  readonly aliases?: Record<string, unknown>;
  readonly strict?: unknown;
  readonly debug?: unknown;
  readonly [key: string]: unknown;
}

export interface LoadedConfigFile {
  /** Ruta del primer archivo existente hallado (ya validado). */
  readonly path: string;
  readonly options: RawFileOptions;
}

export type LoadConfigFileResult =
  | { ok: true; file?: LoadedConfigFile }
  | { ok: false; reason: string };

/**
 * Busca el archivo de configuración más cercano subiendo desde
 * `startDirectory` hasta la raíz del filesystem. El primer
 * `<dir>/.opencode/opencode-model-aliases.jsonc` existente gana: no se
 * fusionan varios archivos ancestrales ni se consultan directorios globales.
 * ENOENT continúa hacia arriba; cualquier otro error de I/O (EISDIR, EACCES…)
 * falla con ruta y código, sin volcar contenido del archivo.
 */
export async function loadConfigFile(startDirectory: string): Promise<LoadConfigFileResult> {
  let current = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(current, CONFIG_DIR, FILE_NAME);
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) return { ok: true };
        current = parent;
        continue;
      }
      return {
        ok: false,
        reason: `config file "${candidate}" could not be read (code: ${code ?? "unknown"})`,
      };
    }

    // El parser es tolerante a fallos: sin inspeccionar `errors` aceptaría
    // datos parciales como si fueran válidos.
    const errors: ParseError[] = [];
    const data = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      if (!first) return { ok: false, reason: `config file "${candidate}" has malformed JSONC` };
      return {
        ok: false,
        reason: `config file "${candidate}" has malformed JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
      };
    }
    if (!isPlainObject(data)) {
      return {
        ok: false,
        reason: `config file "${candidate}" must contain a JSONC object at the root`,
      };
    }
    if (data.aliases !== undefined && !isPlainObject(data.aliases)) {
      return {
        ok: false,
        reason: `config file "${candidate}": aliases must be an object ({} is a valid no-op)`,
      };
    }

    // Se preservan todas las claves propias del archivo, incluidas las
    // desconocidas: el whitelisting ocultaría erratas de raíz antes de
    // validar. El spread copia como propiedad de datos propia, seguro ante
    // claves "__proto__" hostiles. El contenedor de aliases ya fue validado
    // arriba, de ahí el cast.
    const options = { ...data } as RawFileOptions;
    return { ok: true, file: { path: candidate, options } };
  }
}
