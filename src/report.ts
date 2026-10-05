import type { Candidate, NormalizedAlias } from "./config.js";
import type { FailureKind } from "./errors.js";
import { aliasDisplayName } from "./names.js";
import type { ResolveResult } from "./resolve.js";

/** Estado de una fila: el alias resolvió o quedó sin resolver (tolerante). */
export type AliasReportStatus = "resolved" | "unresolved";

/** Estado evaluado en el catálogo final: activo, inactivo (retirado/deshabilitado) o sin resolver. */
export type InspectRowStatus = "active" | "inactive" | "unresolved";

/**
 * Fila estructurada de inspección: datos primitivos públicos con estado final.
 * Se consume en el TUI para mostrar la lista interactiva nativa (dialog.select)
 * y el detalle conciso por alias sin necesidad de parsear el informe en texto.
 */
export interface InspectReportRow {
  readonly key: string;
  readonly provider: string;
  /** Nombre visible: name configurado intacto o el generado por defecto. */
  readonly displayName: string;
  readonly alias: string;
  readonly strategy: "latest";
  readonly status: InspectRowStatus;
  readonly target?: string;
  readonly catalogID?: string;
  readonly providerID?: string;
  readonly wireModelID?: string;
  readonly failureKind?: string;
  readonly failureReason?: string;
}

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
  /** Nombre visible: name configurado intacto o el generado por defecto. */
  readonly displayName: string;
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
    const displayName = aliasDisplayName(alias);
    if (result.ok) {
      const wire = result.model.modelID;
      return {
        key: alias.key,
        strategy: "latest",
        status: "resolved",
        displayName,
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
      displayName,
      failureKind: result.failure.kind,
      failureReason: result.failure.reason,
    } as AliasReportRow;
  });
}

/**
 * Convierte las filas de resolución en filas estructuradas de inspección evaluadas
 * contra la visibilidad del catálogo final. Datos primitivos públicos ordenados
 * determinísticamente por clave (orden de unidades de código).
 */
export function buildInspectRows(
  rows: ReadonlyArray<AliasReportRow>,
  visible: ReadonlySet<string>,
): InspectReportRow[] {
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sorted.map((row) => {
    const slash = row.key.indexOf("/");
    const provider = slash !== -1 ? row.key.slice(0, slash) : row.key;
    const alias = slash !== -1 ? row.key.slice(slash + 1) : row.key;
    const key = sanitize(row.key);
    const safeProvider = sanitize(provider);
    const safeAlias = sanitize(alias);
    const safeDisplayName = sanitize(row.displayName);

    if (row.status === "unresolved") {
      return {
        key,
        provider: safeProvider,
        displayName: safeDisplayName,
        alias: safeAlias,
        strategy: "latest",
        status: "unresolved",
        ...(row.failureKind ? { failureKind: sanitize(row.failureKind) } : {}),
        ...(row.failureReason ? { failureReason: sanitize(row.failureReason) } : {}),
      };
    }

    const isActive = visible.has(row.key);
    const status: InspectRowStatus = isActive ? "active" : "inactive";
    const catalogID = row.catalogID ? sanitize(row.catalogID) : undefined;
    const providerID = row.providerID ? sanitize(row.providerID) : undefined;
    const wireModelID =
      row.wireModelID !== undefined && row.wireModelID !== row.catalogID
        ? sanitize(row.wireModelID)
        : undefined;

    const target =
      providerID && providerID !== safeProvider && catalogID !== undefined
        ? `${providerID}/${catalogID}`
        : catalogID;

    return {
      key,
      provider: safeProvider,
      displayName: safeDisplayName,
      alias: safeAlias,
      strategy: "latest",
      status,
      ...(target !== undefined ? { target } : {}),
      ...(catalogID !== undefined ? { catalogID } : {}),
      ...(providerID !== undefined ? { providerID } : {}),
      ...(wireModelID !== undefined ? { wireModelID } : {}),
    };
  });
}

/**
 * Formato determinista: informe agrupado por proveedor con resumen compacto.
 * Las filas se agrupan por el proveedor literal del alias y se ordenan por
 * clave (orden de unidades de código). Cada alias muestra su nombre visible
 * como etiqueta principal, con el modelID del alias entre paréntesis solo si
 * difiere, y su objetivo indentado en la línea siguiente, sin prefijos
 * redundantes ni etiquetas activas repetitivas; las incidencias (inactivos o
 * sin resolver) y el modelID de ejecución (wire) cuando difiere se destacan
 * explícitamente.
 */
export function formatReport(
  rows: ReadonlyArray<AliasReportRow>,
  visible: ReadonlySet<string>,
): string {
  if (rows.length === 0) return "No aliases configured.";

  const total = rows.length;
  const totalLabel = `${total} alias${total === 1 ? "" : "es"}`;
  const activeCount = rows.filter((r) => r.status === "resolved" && visible.has(r.key)).length;
  const inactiveCount = rows.filter((r) => r.status === "resolved" && !visible.has(r.key)).length;
  const unresolvedCount = rows.filter((r) => r.status === "unresolved").length;

  let summary: string;
  if (inactiveCount === 0 && unresolvedCount === 0) {
    summary = `${totalLabel} · ${activeCount} active`;
  } else {
    const statusParts = [`${activeCount} active`];
    if (inactiveCount > 0) {
      statusParts.push(`${inactiveCount} inactive`);
    }
    if (unresolvedCount > 0) {
      statusParts.push(`${unresolvedCount} unresolved`);
    }
    summary = `${totalLabel} · ${statusParts.join(" · ")}`;
  }

  // Agrupación por proveedor de la clave del alias.
  const groups = new Map<string, AliasReportRow[]>();
  for (const row of rows) {
    const slash = row.key.indexOf("/");
    const provider = slash !== -1 ? row.key.slice(0, slash) : row.key;
    let list = groups.get(provider);
    if (!list) {
      list = [];
      groups.set(provider, list);
    }
    list.push(row);
  }

  const sortedProviders = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const sections = sortedProviders.map((provider) => {
    const providerRows = [...(groups.get(provider) ?? [])].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    const aliasBlocks = providerRows.map((row) => {
      const slash = row.key.indexOf("/");
      const aliasName = slash !== -1 ? row.key.slice(slash + 1) : row.key;
      const safeDisplayName = sanitize(row.displayName);
      const safeAlias = sanitize(aliasName);
      // Etiqueta principal = displayName; solo el modelID del alias se muestra
      // entre paréntesis cuando difiere del nombre visible.
      const aliasLabel =
        row.displayName === aliasName ? safeDisplayName : `${safeDisplayName} (${safeAlias})`;

      if (row.status === "unresolved") {
        const kind = sanitize(row.failureKind ?? "unknown");
        const reason = row.failureReason ? `: ${sanitize(row.failureReason)}` : "";
        return `  ${aliasLabel}\n    → unresolved (${kind})${reason}`;
      }

      const target =
        row.providerID && row.providerID !== provider
          ? `${sanitize(row.providerID)}/${sanitize(row.catalogID ?? "")}`
          : sanitize(row.catalogID ?? "");

      let targetLine = `    → ${target}`;
      if (row.wireModelID !== undefined && row.wireModelID !== row.catalogID) {
        targetLine += ` (wire model ID: ${sanitize(row.wireModelID)})`;
      }
      if (!visible.has(row.key)) {
        targetLine += " (inactive: not in final catalog)";
      }
      return `  ${aliasLabel}\n${targetLine}`;
    });

    return `${sanitize(provider)}\n${aliasBlocks.join("\n")}`;
  });

  return `Model aliases (strategy: latest)\n${summary}\n\n${sections.join("\n\n")}`;
}
