import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

// Golden-file harness (specs/MISSION.md 8). Generic over suites: the core suite registers pure-core
// operations; the session suite (WP 8–9) will register session commands with an injected clock,
// id generator, isolated store and model source via its own `createContext`.

export const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

const RESERVED_FILES = new Set(["steps.json", "expected.json"]);

/** Fixture files of a case as UTF-8 strings, keyed by POSIX path relative to the case folder. */
export type Fixture = Readonly<Record<string, string>>;

export interface Step {
  op: string;
  args?: Record<string, unknown>;
}

export type StepOutcome =
  | { op: string; ok: true; value: unknown }
  | { op: string; ok: false; error: unknown };

export interface CaseInfo<Ctx> {
  name: string;
  fixture: Fixture;
  context: Ctx;
}

export type Operation<Ctx> = (args: Record<string, unknown>, info: CaseInfo<Ctx>) => unknown;

export interface Suite<Ctx> {
  /** Folder containing one sub-folder per case. */
  dir: string;
  /** Fresh per-case context, e.g. state carried between steps. */
  createContext: (name: string, fixture: Fixture) => Ctx;
  operations: Readonly<Record<string, Operation<Ctx>>>;
  /** Maps a thrown value to its golden representation. Rethrow to fail the test. */
  serializeError: (error: unknown) => unknown;
}

export function readFixture(caseDir: string): Fixture {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const rel = relative(caseDir, path).split(sep).join("/");
      if (!RESERVED_FILES.has(rel)) files[rel] = readFileSync(path, "utf8");
    }
  };
  walk(caseDir);
  return files;
}

export function listCases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/**
 * Deterministic golden encoding: sorted object keys, two-space indentation, trailing newline.
 * Values JSON cannot represent exactly are tagged so they never compare equal by accident.
 */
export function toGolden(value: unknown): string {
  return `${JSON.stringify(encode(value), null, 2)}\n`;
}

function encode(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "undefined") return { $undefined: true };
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { $number: "-0" };
    if (!Number.isFinite(value)) return { $number: String(value) };
    return value;
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [encode(k), encode(v)]) };
  if (value instanceof Set) return { $set: [...value].map(encode) };
  if (value !== null && typeof value === "object") {
    const source = typeof (value as { toJSON?: unknown }).toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
    if (source !== value) return encode(source);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = encode((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function parseSteps(text: string, caseName: string): Step[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${caseName}: steps.json must be an array`);
  return parsed.map((step, index) => {
    if (step === null || typeof step !== "object" || typeof (step as Step).op !== "string") {
      throw new Error(`${caseName}: step ${index} needs a string "op"`);
    }
    return step as Step;
  });
}

export function runCase<Ctx>(suite: Suite<Ctx>, name: string): StepOutcome[] {
  const caseDir = join(suite.dir, name);
  const stepsPath = join(caseDir, "steps.json");
  if (!existsSync(stepsPath)) throw new Error(`${name}: missing steps.json`);
  const steps = parseSteps(readFileSync(stepsPath, "utf8"), name);
  const fixture = readFixture(caseDir);
  const info: CaseInfo<Ctx> = { name, fixture, context: suite.createContext(name, fixture) };

  return steps.map((step): StepOutcome => {
    const operation = suite.operations[step.op];
    if (!operation) throw new Error(`${name}: unknown operation "${step.op}"`);
    try {
      return { op: step.op, ok: true, value: operation(step.args ?? {}, info) };
    } catch (error) {
      return { op: step.op, ok: false, error: suite.serializeError(error) };
    }
  });
}

/** Registers one vitest test per case folder. */
export function defineGoldenSuite<Ctx>(title: string, suite: Suite<Ctx>): void {
  const cases = listCases(suite.dir);
  describe(title, () => {
    if (cases.length === 0) test.skip("no cases", () => {});
    for (const name of cases) {
      test(name, () => {
        const actual = toGolden(runCase(suite, name));
        const expectedPath = join(suite.dir, name, "expected.json");
        if (UPDATE_GOLDEN) {
          writeFileSync(expectedPath, actual);
          return;
        }
        if (!existsSync(expectedPath)) {
          throw new Error(`${name}: missing expected.json, run with UPDATE_GOLDEN=1 and review the diff`);
        }
        expect(actual).toBe(readFileSync(expectedPath, "utf8"));
      });
    }
  });
}
