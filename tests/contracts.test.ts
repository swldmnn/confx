import { describe, expect, test } from "vitest";
import { Blocker, ConfxError, ErrorPayload, EvalError, Result, State, VariableState } from "../src/core/index.js";

const variable: VariableState = {
  id: "width", kind: "parameter", type: "int", section: "dimensions",
  nameKey: "width.name", descriptionKey: "width.description",
  value: null, status: "unset", source: "none", multiple: false, mandatory: true, available: true,
  min: 60, max: 200, tainted: false, errorDerived: false,
};

describe("contracts", () => {
  test("accepts a minimal state", () => {
    const state = {
      variables: { width: variable }, targets: {}, sections: [], conflicts: [], errors: [], warnings: [],
      completion: { canFinish: false, blockers: [{ kind: "open_mandatory", ref: "width" }] },
    };
    expect(State.parse(state)).toEqual(state);
  });

  test("rejects unknown fields", () => {
    expect(VariableState.safeParse({ ...variable, extra: 1 }).success).toBe(false);
  });

  test("dataKey requires field data", () => {
    expect(EvalError.safeParse({ target: "position:desk", ruleId: null, message: "x", field: "price", dataKey: "k" }).success).toBe(false);
    expect(EvalError.safeParse({ target: "position:desk", ruleId: null, message: "x", field: "data", dataKey: "k" }).success).toBe(true);
  });

  test("position blockers reference positions", () => {
    expect(Blocker.safeParse({ kind: "position", ref: "desk", status: "incomplete" }).success).toBe(false);
    expect(Blocker.safeParse({ kind: "position", ref: "position:desk", status: "incomplete" }).success).toBe(true);
  });

  test("empty result", () => {
    const result = { status: "provisional", currency: null, items: [], total: 0, conflicts: [], errors: [] };
    expect(Result.parse(result)).toEqual(result);
  });

  test("ConfxError serializes to its payload schema", () => {
    const error = new ConfxError("unknown_variable", "Unknown variable widht", { variable: "widht" });
    expect(ErrorPayload.parse(error.toJSON())).toEqual({
      code: "unknown_variable", message: "Unknown variable widht", details: { variable: "widht" },
    });
    expect(ErrorPayload.safeParse({ code: "unknown_variable", message: "x", details: { id: "x" } }).success).toBe(false);
    expect(new ConfxError("internal_error", "boom").toJSON()).toEqual({ code: "internal_error", message: "boom" });
  });
});
