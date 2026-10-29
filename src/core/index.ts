// Pure core entry point (`confx/core`). Must stay free of Node imports (specs/MISSION.md 6.1).
export * from "./contracts/index.js";
export { ConfxError, isConfxError } from "./errors.js";
export { engineVersion, SUPPORTED_SCHEMA_VERSIONS } from "./version.js";
