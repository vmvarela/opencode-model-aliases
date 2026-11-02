export type {
  AliasConfig,
  AllowedStatus,
  Candidate,
  CapabilityRequirement,
  Checker,
  FilterOptions,
  ModelStatus,
  NormalizedAlias,
  NormalizedConfig,
  Options,
  SelectionStrategy,
  SelectOptions,
} from "./config.js";
export { type FailureKind, failure, type ResolveFailure } from "./errors.js";
export { normalizeOptions, type Selector, splitSelector } from "./normalize.js";
export { default } from "./plugin.js";
export { type ResolveResult, resolveLatest, type SelectionSignals, type Stage } from "./resolve.js";
