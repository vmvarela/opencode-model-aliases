import type { Model } from "@opencode/plugin";
import { describe, expectTypeOf, it } from "vitest";
import type { Candidate } from "../src/index.js";

/**
 * Compile-time assertion: the real Model.Info from @opencode/plugin
 * satisfies the resolver's minimal contract, without casts or `any`.
 */
describe("v2 conformance", () => {
  it("Model.Info cumple el contrato Candidate", () => {
    expectTypeOf<Model.Info>().toExtend<Candidate>();
    type Check = Model.Info extends Candidate ? true : never;
    const check: Check = true;
    expectTypeOf(check).toEqualTypeOf<true>();
  });
});
