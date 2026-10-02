import type { Candidate, NormalizedAlias } from "./config.js";
import type { FailureKind } from "./errors.js";
import type { ResolveResult } from "./resolve.js";

/** Estado de una fila: el alias resolvió o quedó sin resolver (tolerante). */
export type AliasReportStatus = "resolved" | "unresolved";

/**
 * Fila de informe: SOLO datos primitivos públicos. Nunca Model.Info completo,
 * settings, headers, body, credenciales ni objetos de configuración.
 */
export interface AliasReportRow {
  /** Referencia del alias `<provider>/<model>` (clave de configuración). */
  readonly key: string;
  /** Única estrategia implementada. */
  readonly strategy: "latest";
  readonly status: AliasReportStatus;
  /** Solo resolved: ganador real del catálogo. */
  readonly providerID?: string;
  readonly catalogID?: string;
  /** Solo resolved: modelID de ejecución (wire); se menciona por separado. */
  readonly wireModelID?: string;
  /** Solo unresolved. */
  readonly failureKind?: FailureKind;
  readonly failureReason?: string;
}

/**
 * Mensaje estático de indisponibilidad: la última repetición falló, el
 * catálogo no pudo leerse o el mapeo publicado no pudo confirmarse contra el
 * catálogo final (una política posterior cambió la identidad del alias).
 * Nunca se sirve un snapshot previo/stale ni el error crudo.
 */
export const UNAVAILABLE_REPORT =
  "Model alias inspection is unavailable: the current alias mapping could not be confirmed against the final catalog.";

/** Caracteres de control C0/C1 (incluye ESC/CSI y \x7F) — no seguros en TTY. */
const CONTROL = /\p{Cc}/gu;

/** Sustituye caracteres de control por su escape `\uXXXX`; sin más cambios. */
export function sanitize(value: string): string {
  return value.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Construye las filas del informe a partir de los MISMOS resultados de
 * resolución que usa el transform para materializar. Sin consultas extra.
 */
export function buildRows<T extends Candidate & { readonly modelID?: string }>(
  results: ReadonlyArray<{ alias: NormalizedAlias; result: ResolveResult<T> }>,
): AliasReportRow[] {
  return results.map(({ alias, result }) => {
    if (result.ok) {
      const wire = result.model.modelID;
      return {
        key: alias.key,
        strategy: "latest",
        status: "resolved",
        providerID: result.model.providerID,
        catalogID: result.model.id,
        // El modelID de ejecución solo interesa por separado si difiere.
        ...(wire !== undefined && wire !== result.model.id ? { wireModelID: wire } : {}),
      } as AliasReportRow;
    }
    return {
      key: alias.key,
      strategy: "latest",
      status: "unresolved",
      failureKind: result.failure.kind,
      failureReason: result.failure.reason,
    } as AliasReportRow;
  });
}

/**
 * Formato determinista: filas ordenadas por clave de alias (orden de
 * unidades de código). Una fila resuelta se etiqueta `active` solo si el
 * alias sigue visible en el catálogo final; una política posterior puede
 * haber retirado el alias materializado.
 */
export function formatReport(
  rows: ReadonlyArray<AliasReportRow>,
  visible: ReadonlySet<string>,
): string {
  if (rows.length === 0) return "No aliases configured.";
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const lines = sorted.map((row) => {
    const key = sanitize(row.key);
    if (row.status === "unresolved") {
      return `  ${key} → unresolved (${row.failureKind}): ${sanitize(row.failureReason ?? "")}`;
    }
    const target = `${sanitize(row.providerID ?? "")}/${sanitize(row.catalogID ?? "")}`;
    let line = `  ${key} → ${target}`;
    line += visible.has(row.key) ? " (active)" : " (inactive: not in final catalog)";
    if (row.wireModelID !== undefined && row.wireModelID !== row.catalogID) {
      line += ` (wire modelID: ${sanitize(row.wireModelID)})`;
    }
    return line;
  });
  return `Model aliases (strategy: latest):\n${lines.join("\n")}`;
}
