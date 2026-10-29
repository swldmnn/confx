import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

// The core/session boundary is enforced by lint (specs/MISSION.md 6.1).
const eslint = new ESLint();

const lint = async (code: string, filePath: string) => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId?.startsWith("no-restricted")).map((m) => m.ruleId);
};

describe("core boundary lint", () => {
  test.each([
    'import { readFileSync } from "fs";',
    'import { readFileSync } from "node:fs";',
    'import { createHash } from "crypto";',
    'import { join } from "path";',
    'import { x } from "../session/index.js";',
    "export const env = process.env;",
  ])("rejects in core: %s", async (code) => {
    expect(await lint(code, "src/core/__probe__.ts")).not.toEqual([]);
  });

  test("allows Node imports in the session layer", async () => {
    expect(await lint('import { readFileSync } from "node:fs";\nexport { readFileSync };', "src/session/__probe__.ts")).toEqual([]);
  });

  test("allows pure dependencies in core", async () => {
    expect(await lint('import { z } from "zod";\nexport { z };', "src/core/__probe__.ts")).toEqual([]);
  });
});
