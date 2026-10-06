import { isPlainObject } from "./config.js";

export interface AliasTransition {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly fromWireModelID: string;
  readonly toWireModelID: string;
  readonly changedAt: string;
}

export function isAliasTransition(value: unknown): value is AliasTransition {
  return (
    isPlainObject(value) &&
    [value.id, value.from, value.to, value.fromWireModelID, value.toWireModelID].every(
      (part) => typeof part === "string" && part.length > 0,
    ) &&
    typeof value.changedAt === "string" &&
    Number.isFinite(Date.parse(value.changedAt))
  );
}
