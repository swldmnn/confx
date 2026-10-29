import { fileURLToPath } from "node:url";
import { ConfxError, engineVersion } from "../../../src/core/index.js";
import { defineGoldenSuite, type Operation } from "../harness.js";

// Pure-core golden suite. Operations receive fixture contents as strings only: no filesystem,
// clock, random ids or session APIs (specs/MISSION.md 8). Each work package registers its operations here
// (WP 1: loadModel/hashModel, WP 3+: evaluate, ...).

interface CoreContext {
  /** Values carried between steps of one case, e.g. a loaded model. */
  vars: Map<string, unknown>;
}

const operations: Record<string, Operation<CoreContext>> = {
  engineVersion: () => engineVersion,
  fixtureFiles: (_args, { fixture }) => Object.keys(fixture),
};

defineGoldenSuite<CoreContext>("golden: core", {
  dir: fileURLToPath(new URL(".", import.meta.url)),
  createContext: () => ({ vars: new Map() }),
  operations,
  serializeError: (error) => {
    if (error instanceof ConfxError) return error.toJSON();
    throw error;
  },
});
