import type { Candidate, Checker, NormalizedAlias } from "./config.js";
import { failure, type ResolveFailure } from "./errors.js";

export interface Stage {
  name: "matching" | "filtering" | "selection";
  accepted: number;
}

export type ResolveResult<T> =
  | { ok: true; model: T; stages: Stage[] }
  | { ok: false; failure: ResolveFailure };

/** Identificador canónico `<providerID>/<id>` usado por matching y exclusiones. */
function canonical(candidate: Candidate): string {
  return `${candidate.providerID}/${candidate.id}`;
}

/** Fecha fiable: número finito mayor que 0 (milisegundos). */
function releasedMs(candidate: Candidate): number {
  const released = candidate.time.released;
  return typeof released === "number" && Number.isFinite(released) && released > 0 ? released : 0;
}

/**
 * Selección pura a partir de la lista fuente provista. Sin efectos
 * secundarios ni mutación de la entrada; el resolvedor nunca añade modelos
 * derivados de alias fuera de la lista explícita.
 */
export function resolveLatest<T extends Candidate>(
  models: readonly T[],
  alias: NormalizedAlias,
): { ok: true; model: T; stages: Stage[] } | { ok: false; failure: ResolveFailure } {
  if (!Array.isArray(models)) {
    return { ok: false, failure: failure("no-candidates", "source list must be an array") };
  }
  const stages: Stage[] = [];

  // Etapa 1: matching — includes y excludes sobre el id canónico.
  const matched = models.filter((candidate) => {
    // Defensa en profundidad: la igualdad de proveedor no depende de los matchers.
    if (candidate.providerID !== alias.provider) return false;
    const id = canonical(candidate);
    if (!alias.includes.some((check) => check(id))) return false;
    return !alias.excludes.some((check) => check(id));
  });
  stages.push({ name: "matching", accepted: matched.length });
  if (matched.length === 0) {
    return {
      ok: false,
      failure:
        models.length === 0
          ? failure("no-candidates", "source list is empty")
          : failure("no-eligible", "no candidate matched match/exclude patterns"),
    };
  }

  // Etapa 2: filtering — enabled + estatus admitidos por el alias.
  const eligible = matched.filter(
    (candidate) => candidate.enabled !== false && alias.statuses.includes(candidate.status),
  );
  stages.push({ name: "filtering", accepted: eligible.length });
  if (eligible.length === 0) {
    return {
      ok: false,
      failure: failure("no-eligible", "no candidate passed enabled/status filtering"),
    };
  }

  // Etapa 3: selection — latest; fechas desconocidas nunca ganan.
  const known = eligible.filter((candidate) => releasedMs(candidate) > 0);
  if (known.length === 0) {
    return {
      ok: false,
      failure: failure(
        "missing-metadata",
        "no eligible candidate has a reliable time.released timestamp",
      ),
    };
  }
  const sorted = [...known].sort((a, b) => {
    const delta = releasedMs(b) - releasedMs(a);
    if (delta !== 0) return delta;
    if (a.id === b.id) return 0;
    // Descendente, orden por unidades de código, independiente del locale.
    return a.id < b.id ? 1 : -1;
  });
  const winner = sorted[0];
  if (!winner) {
    return { ok: false, failure: failure("no-eligible", "selection produced no candidate") };
  }
  return { ok: true, model: winner, stages: [...stages, { name: "selection", accepted: 1 }] };
}

export type { Checker };
