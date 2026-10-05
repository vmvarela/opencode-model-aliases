import type { Model } from "@opencode/plugin";
import { describe, expectTypeOf, it } from "vitest";
import type { Candidate } from "../src/index.js";

/**
 * Compile-time assertions: the real Model.Info from @opencode/plugin
 * satisfies the resolver's minimal contract, without casts or `any`.
 *
 * The Candidate fields backing the capability/context filters are OPTIONAL
 * (backwards compatibility with minimal inputs), so plain extension alone
 * would NOT notice if OpenCode v2 dropped those fields. The second
 * assertion demands them structurally, so a removal fails loudly here.
 */
describe("v2 conformance", () => {
  it("Model.Info cumple el contrato Candidate", () => {
    expectTypeOf<Model.Info>().toExtend<Candidate>();
    type Check = Model.Info extends Candidate ? true : never;
    const check: Check = true;
    expectTypeOf(check).toEqualTypeOf<true>();
  });

  it("Model.Info conserva los campos de capacidades y contexto que filtran los alias", () => {
    type CapabilityFields = {
      readonly tools: boolean;
      readonly input: readonly string[];
      readonly output: readonly string[];
    };
    type LimitFields = { readonly context: number };
    type RequiredFields = Candidate & {
      readonly capabilities: CapabilityFields;
      readonly limit: LimitFields;
    };
    type Check = Model.Info extends RequiredFields ? true : never;
    const check: Check = true;
    expectTypeOf(check).toEqualTypeOf<true>();
  });
});
