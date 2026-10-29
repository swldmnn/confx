import tseslint from "typescript-eslint";

const nodeBuiltins = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "crypto",
  "dgram", "diagnostics_channel", "dns", "events", "fs", "fs/promises", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "querystring", "readline", "repl", "stream", "string_decoder", "timers", "tls",
  "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: nodeBuiltins.map((name) => ({
            name,
            message: "The core must stay free of Node imports (specs/MISSION.md 6.1).",
          })),
          patterns: [
            { group: ["node:*"], message: "The core must stay free of Node imports (specs/MISSION.md 6.1)." },
            { group: ["**/session/**", "**/cli/**"], message: "The core must not depend on the session layer or CLI." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "The core must not access the process (specs/MISSION.md 6.1)." },
        { name: "Buffer", message: "The core must stay free of Node APIs (specs/MISSION.md 6.1)." },
      ],
    },
  },
  {
    files: ["src/session/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/cli/**"], message: "The session layer must not depend on the CLI." }] },
      ],
    },
  },
);
