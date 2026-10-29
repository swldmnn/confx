import { Environment, EvaluationError } from "@marcbachmann/cel-js";
import { describe, expect, test } from "vitest";

// Pinned-library verification (specs/MISSION.md 3.3, 3.4, 3.12, WP 2 gates). The engine relies on
// every behavior asserted here; a library upgrade that changes any of it must fail this suite.
// Findings and the local patch are documented in specs/cel-verification.md.

const MAX = 9223372036854775807n;
const MIN = -9223372036854775808n;

const env = new Environment().registerVariable("i", "int").registerVariable("d", "double");

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluationError);
    return (error as EvaluationError).code;
  }
  throw new Error("expected an EvaluationError");
};

describe("signed 64-bit int contract", () => {
  test.each([
    ["i + 1", MAX],
    ["i - 1", MIN],
    ["i * 2", MAX],
    ["-i", MIN], // patched
    ["i / -1", MIN], // patched
  ])("%s overflows at the boundary", (expr, i) => {
    expect(errorCode(() => env.evaluate(expr, { i }))).toBe("numeric_overflow");
  });

  test("boundary values themselves are fine", () => {
    expect(env.evaluate("i + 0", { i: MAX })).toBe(MAX);
    expect(env.evaluate("i - 0", { i: MIN })).toBe(MIN);
    expect(env.evaluate("-i", { i: -MAX })).toBe(MAX);
    expect(env.evaluate("i % -1", { i: MIN })).toBe(0n);
  });

  test("literals: min literal parses as negated 2^63", () => {
    expect(env.evaluate("9223372036854775807")).toBe(MAX);
    expect(env.evaluate("-9223372036854775808")).toBe(MIN);
    expect(env.parse("-9223372036854775808").ast.toOldStructure()).toEqual(["-_", ["value", 2n ** 63n]]);
    expect(errorCode(() => env.evaluate("-9223372036854775809"))).toBe("numeric_overflow");
  });

  test("KNOWN GAP: a standalone 2^63 literal is accepted; the validator must reject it", () => {
    expect(env.evaluate("9223372036854775808")).toBe(2n ** 63n);
  });

  test("int inputs outside the range are rejected", () => {
    expect(errorCode(() => env.evaluate("i + 0", { i: MAX + 1n }))).toBe("numeric_overflow");
  });

  test("division truncates toward zero; zero divisors error", () => {
    expect(env.evaluate("i / 2", { i: -7n })).toBe(-3n);
    expect(env.evaluate("i % 2", { i: -7n })).toBe(-1n);
    expect(errorCode(() => env.evaluate("i / 0", { i: 1n }))).toBe("division_by_zero");
    expect(errorCode(() => env.evaluate("i % 0", { i: 1n }))).toBe("modulo_by_zero");
  });

  test.each([9.3e18, -9.3e18, 2 ** 63, NaN, Infinity])("int(%s) overflows", (d) => {
    expect(errorCode(() => env.evaluate("int(d)", { d }))).toBe("numeric_overflow"); // range patched
  });

  test("int(double) truncates and accepts -2^63", () => {
    expect(env.evaluate("int(d)", { d: 2.7 })).toBe(2n);
    expect(env.evaluate("int(d)", { d: -2.7 })).toBe(-2n);
    expect(env.evaluate("int(d)", { d: -(2 ** 63) })).toBe(MIN);
  });

  test("int(string) is range checked", () => {
    expect(env.evaluate('int("9223372036854775807")')).toBe(MAX);
    expect(errorCode(() => env.evaluate('int("9223372036854775808")'))).toBe("int_conversion_error");
  });

  test("strict typing: int variables require bigint, int + double does not type-check", () => {
    expect(errorCode(() => env.evaluate("i + 1", { i: 5 }))).toBe("variable_type_mismatch");
    expect(env.check("i + d").valid).toBe(false);
  });
});

describe("double semantics", () => {
  test("KNOWN GAP: non-finite doubles are produced silently; the engine must check them", () => {
    expect(env.evaluate("d / 0.0", { d: 1 })).toBe(Infinity);
    expect(env.evaluate("d / 0.0", { d: 0 })).toBeNaN();
    expect(env.evaluate("d * 10.0", { d: 1e308 })).toBe(Infinity);
  });
});

describe("unknown and presence", () => {
  test("missing variable has a stable error code", () => {
    expect(errorCode(() => env.evaluate("i + 1", {}))).toBe("unknown_variable");
  });

  test("short-circuit skips missing variables", () => {
    expect(env.evaluate("false && i > 1", {})).toBe(false);
    expect(env.evaluate("true || i > 1", {})).toBe(true);
  });

  test("has(set.x) presence map", () => {
    const e = new Environment().registerVariable("set", "map").registerVariable("x", "int");
    expect(e.evaluate("has(set.x) && x > 3", { set: {} })).toBe(false);
    expect(e.evaluate("has(set.x) && x > 3", { set: { x: true }, x: 5n })).toBe(true);
    expect(e.check("has(set.widht)").valid).toBe(true); // typos are invisible to check(): validator scans the AST
  });
});

describe("engine helpers", () => {
  test("min/max/abs/round are not built in and can be registered", () => {
    expect(errorCode(() => env.evaluate("min(1, 2)"))).toBe("no_matching_overload");
    expect(errorCode(() => env.evaluate("abs(-1)"))).toBe("no_matching_overload");
    expect(errorCode(() => env.evaluate("round(1.5, 0)"))).toBe("no_matching_overload");
    const e = new Environment()
      .registerFunction("min(int, int): int", (a: bigint, b: bigint) => (a < b ? a : b))
      .registerFunction("min(double, double): double", (a: number, b: number) => Math.min(a, b));
    expect(e.evaluate("min(3, 2)")).toBe(2n);
    expect(e.evaluate("min(1.5, 2.5)")).toBe(1.5);
    expect(e.check("min(1, 2.5)").valid).toBe(false);
  });

  test("built-in operators and functions cannot be overridden", () => {
    expect(() => new Environment().registerOperator("int / int", () => 0n)).toThrow(/already registered/);
    expect(() => new Environment().registerFunction("int(double): int", () => 0n)).toThrow(/overlaps/);
  });
});

describe("globally bound names (reserved identifiers)", () => {
  test("the global environment binds exactly these variable names", () => {
    const names = new Environment().getDefinitions().variables.map((v) => v.name).sort();
    expect(names).toEqual(["bool", "bytes", "cel", "double", "google", "int", "list", "map", "null_type", "optional", "string", "type", "uint"]);
  });

  test.each(["google", "optional", "cel", "string", "map"])("variable %s cannot be registered", (name) => {
    expect(() => new Environment().registerVariable(name, "int")).toThrow(/already registered/);
  });

  test.each(["size", "has", "set", "row", "min", "join", "matches"])("function names do not block variable %s", (name) => {
    expect(new Environment().registerVariable(name, "int").evaluate(`${name} + 1`, { [name]: 1n })).toBe(2n);
  });
});

describe("tables: typed rows in map<string, Row>", () => {
  class Row {
    constructor(fields: Record<string, unknown>) {
      Object.assign(this, fields);
    }
  }
  const tenv = new Environment()
    .registerType("products_Row", { ctor: Row, fields: { basePrice: "double", availableQuantity: "int", label: "string" } })
    .registerVariable("products", "map<string, products_Row>")
    .registerVariable("product", "string")
    .registerVariable("row", "products_Row");
  const products = new Map([
    ["PNL-OAK-19", new Row({ basePrice: 48.0, availableQuantity: 12n, label: "Oak" })],
    ["4711-00", new Row({ basePrice: 35.9, availableQuantity: 3n, label: "Birch" })],
    ["A.12/3", new Row({ basePrice: 1.0, availableQuantity: 0n, label: "Dotted" })],
  ]);

  test("lookups type-check against declared columns", () => {
    expect(tenv.check("products[product].basePrice").type).toBe("double");
    expect(tenv.check("products[product].availableQuantity").type).toBe("int");
    expect(tenv.check("products[product].baseprice").valid).toBe(false);
    expect(tenv.check("row.label + 1").valid).toBe(false);
  });

  test("lookups evaluate, including keys that are not identifiers", () => {
    expect(tenv.evaluate("products[product].basePrice", { products, product: "4711-00" })).toBe(35.9);
    expect(tenv.evaluate('products["A.12/3"].label', { products })).toBe("Dotted");
  });

  test("a missing key has a distinguishable error code", () => {
    expect(errorCode(() => tenv.evaluate("products[product].basePrice", { products, product: "nope" }))).toBe("no_such_key");
  });

  test("in, exists, all and size work on table maps", () => {
    expect(tenv.evaluate("product in products", { products, product: "nope" })).toBe(false);
    expect(tenv.evaluate("product in products && products[product].availableQuantity > 0", { products, product: "nope" })).toBe(false);
    expect(tenv.evaluate("products.exists(k, products[k].availableQuantity > 5)", { products })).toBe(true);
    expect(tenv.evaluate("products.all(k, products[k].basePrice > 0.5)", { products })).toBe(true);
    expect(tenv.evaluate("size(products)", { products })).toBe(3n);
  });

  test("row binding for choicesFrom filters", () => {
    expect(tenv.evaluate("row.availableQuantity > 0", { row: products.get("4711-00") })).toBe(true);
    expect(tenv.evaluate("row.availableQuantity > 0", { row: products.get("A.12/3") })).toBe(false);
  });

  test("rows must be instances of the registered type with correctly typed fields", () => {
    const plain = new Map([["x", { basePrice: 1.0, availableQuantity: 1n, label: "x" }]]);
    expect(errorCode(() => tenv.evaluate('products["x"].label', { products: plain }))).toBe("field_type_mismatch");
    const badInt = new Row({ basePrice: 1, availableQuantity: 5, label: "x" });
    expect(errorCode(() => tenv.evaluate("row.availableQuantity > 0", { row: badInt }))).toBe("field_type_mismatch");
  });
});
