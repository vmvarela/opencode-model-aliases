import type { Model } from "@opencode/plugin";
import { describe, expectTypeOf, it } from "vitest";
import type { Candidate } from "../src/index.js";

/**
 * Aserción en tiempo de compilación: el Model.Info real de @opencode/plugin
 * satisface el contrato mínimo del resolvedor, sin casts ni `any`.
 */
describe("v2 conformance", () => {
  it("Model.Info cumple el contrato Candidate", () => {
    expectTypeOf<Model.Info>().toExtend<Candidate>();
    type Check = Model.Info extends Candidate ? true : never;
    const check: Check = true;
    expectTypeOf(check).toEqualTypeOf<true>();
  });
});
