export type {
  AliasConfig,
  AllowedStatus,
  Candidate,
  Checker,
  FilterOptions,
  ModelStatus,
  NormalizedAlias,
  NormalizedConfig,
  Options,
  SelectOptions,
} from "./config.js";
export { type FailureKind, failure, type ResolveFailure } from "./errors.js";
export { normalizeOptions, type Selector, splitSelector } from "./normalize.js";
export { type ResolveResult, resolveLatest, type Stage } from "./resolve.js";
