# confX

confX is a generic, embeddable evaluation engine for **configurable products** (CPQ: configure, price, quote).

All product logic lives in a declarative YAML **model**: parameters the user chooses, rules that compute values and constraints, and items that become order lines. The engine has no domain knowledge. Whenever a parameter changes, it re-evaluates the whole model and returns a consistent state: values, constraints, conflicts, errors, the next open question, and a priced list of order lines.

> **Status: early implementation.** The specification is complete ([`specs/MISSION.md`](specs/MISSION.md)). Project setup (WP 0) is done, and the CEL expression library has been verified (part of WP 2, see [`specs/cel-verification.md`](specs/cel-verification.md)). The model loader, evaluator, session layer and CLI are **not implemented yet**. API and CLI sections below describe the specified design, not working code.

## Contents

- [Why confX](#why-confx)
- [Core concepts](#core-concepts)
- [A model at a glance](#a-model-at-a-glance)
- [Evaluation in brief](#evaluation-in-brief)
- [Architecture](#architecture)
- [Planned API](#planned-api)
- [Planned CLI](#planned-cli)
- [Development](#development)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Documentation](#documentation)

## Why confX

- **Declarative models.** Product experts write YAML and [CEL](https://cel.dev) expressions. They don't write code.
- **Deterministic.** Evaluation is a pure function of model, inputs and table data. Sessions store only the user's inputs, and the full state is recomputed on every call.
- **Never silently wrong.** A value that violates a constraint is kept and reported as a conflict, not dropped. Undecidable values are `unknown`, errors are reported per target, and nothing can be finished while conflicts or relevant errors remain.
- **Exact prices.** Unit prices are rounded first, then multiplied and summed in integer minor units. The result total is the single source of truth for the price.
- **Auditable.** Finishing a session stores a self-contained snapshot: the final state, the order lines, the inputs, the full model and translations, and the table data used.
- **Embeddable.** The core has no I/O, so it can run in the browser. A session layer and a JSON CLI sit on top.

**Not in v1:** UI, quote documents, tax, multiple currencies, user management, a database, an HTTP server, and session locking.

## Core concepts

| Concept | Meaning |
|---|---|
| **Model** | YAML file with variables, rules, items and table declarations. Immutable at runtime. |
| **Parameter** | A value the user provides (e.g. width, material). Can be mandatory, have a default, and carry constraints (`min`, `max`, `format`, choices, availability). |
| **Internal** | A helper value: either a **constant** (its default, which can be overridden once when a session starts) or **calculated** by rules. |
| **Output** | A calculated value (e.g. area). Never set directly. |
| **Rule** | A CEL expression that assigns a value or changes an attribute (`min`, `max`, `available`, per-choice availability). Optional `when:` guards, first match wins. |
| **Item** | A template for one order line: article, quantity, unit price and extra data, optionally conditional. |
| **Table** | Reference data (e.g. products with prices and stock) declared in the model and supplied from outside. Pinned per session. |
| **Session** | One configuration run. Stores only inputs and pinned table data, never derived state. |
| **Result** | The export for external systems such as an e-shop: order lines plus the total. |

All texts live in one translation file per locale. Models contain only translation ids, and `localize` turns them into text.

## A model at a glance

A minimal desk (the full example is in [`specs/MISSION.md` §11.1](specs/MISSION.md) and in `tests/golden/core/desk/`):

```yaml
schemaVersion: 1
model: desk
modelVersion: "1.0"
defaultLocale: en
translations: {en: i18n/en.yaml, de: i18n/de.yaml}
variables:
  - {id: material, kind: parameter, type: choice, mandatory: true, choices: [{id: oak}, {id: steel}]}
  - {id: width, kind: parameter, type: int, min: 60, max: 200, mandatory: true}
  - {id: pricePerCm, kind: internal, type: float, default: 1.5}
  - {id: deskArticle, kind: internal, type: string, default: "DSK-100"}
rules:
  - {id: max_steel, target: width.max, when: 'material == "steel"', expr: '160'}
pricing: {currency: EUR, pricePrecision: 2}
items:
  - {id: desk, article: deskArticle, price: 'double(width) * pricePerCm'}
```

```yaml
# i18n/en.yaml
material.name: Material
material.choices.oak: Oak
material.choices.steel: Steel
width.name: Width
desk.name: Desk
```

What happens:
- With nothing set, the price is `unknown`, the `desk` line is `incomplete`, and the total is `null`.
- With `material: steel`, the maximum width becomes 160. A width of 180 is then an `out_of_range` conflict caused by rule `max_steel`, and the session can't be finished.
- With `material: oak` and `width: 120`, the desk line costs 180.00 EUR.

Expressions use strict CEL typing: `int` and `float` don't mix without explicit conversion (`double(width)`).

## Evaluation in brief

The normative rules are in [`specs/MISSION.md` §3–4](specs/MISSION.md). The essentials:

1. **Dependency graph.** Rules form a graph of targets (values and attributes). It is evaluated in topological order, and cycles are model errors.
2. **First match.** Rules for one target are tried in order, and the first rule whose `when` is true is used. A rule without `when` is the fallback and must come last.
3. **Unknown.** A rule that needs an unset value gives `unknown`. That is not an error, and CEL short-circuiting still applies (`false && x` is `false`). `has(set.x)` tests whether `x` has a value.
4. **Conflicts.** User inputs that violate constraints are kept and reported with their cause. Values that depend on a conflict are marked `tainted`.
5. **Errors.** Division by zero, integer overflow and similar failures are reported per target and never crash a session.
6. **Completion.** A session can be finished only when all available mandatory parameters have values, there are no conflicts or relevant errors, and every listed order line is complete.

Numbers: `int` is exact signed 64-bit (`bigint`), with overflow as an error. `float` is an IEEE double with optional `precision` rounding (half away from zero). There is no decimal type in v1.

## Architecture

Three layers, with the boundary enforced by lint:

| Layer | Entry point | Responsibility |
|---|---|---|
| **Core** | `confx/core` | Pure functions: load, validate, evaluate, build the result, localize, diff, hash. No files, clock or random ids. Works in the browser. |
| **Session** | `confx` | Sessions as atomic JSON files, model and data sources, version and change checks, snapshots, derivation. |
| **CLI** | `confx` bin | Argument parsing, JSON on stdout, exit codes. No logic of its own. |

Tech stack: TypeScript, Node.js ≥ 24, ESM only. Libraries: [`@marcbachmann/cel-js`](https://github.com/marcbachmann/cel-js) for expressions, [`yaml`](https://eemeli.org/yaml/) for parsing, [`zod`](https://zod.dev) for schemas (the source of truth for all public contracts), and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) for SHA-256.

## Planned API

> Not implemented yet. Signatures follow [`specs/MISSION.md` §6](specs/MISSION.md).

**Core (pure):**

```ts
import { loadModel, validateModel, evaluate, buildResult, localize } from "confx/core";

const model = loadModel(yamlText, { en: enYaml, de: deYaml });
const evaluation = evaluate(model, { material: "oak", width: 120n }, {});
const result = buildResult(model, evaluation, "provisional");
const localized = localize(model, result, "de");
```

**Sessions:** every command returns `{ data, notices }`.

```ts
import { startSession, setParameter, getNextOpenParameter, getOrderLines, finishSession } from "confx";

const { data: { sessionId } } = await startSession("desk/model.yaml");
await setParameter(sessionId, "material", "oak");
const next = await getNextOpenParameter(sessionId);       // e.g. the "width" parameter
await setParameter(sessionId, "width", 120);
const lines = await getOrderLines(sessionId, { locale: "en" });
const finished = await finishSession(sessionId);          // { finished: true, state, result } or blockers
```

Other commands: `resetParameter`, `getState`, `deriveSession` (a new session from an existing one, with a diff, e.g. to re-price an old configuration), and `validateModelFile`. Failures throw `ConfxError` with a stable `code` (already implemented in `src/core/errors.ts`).

## Planned CLI

> Not implemented yet. The current `confx` binary is a stub.

```sh
confx validate desk/model.yaml
confx start desk/model.yaml --initial-values '{"width":120}'
confx set   --session <id> material oak
confx next  --session <id>
confx lines --session <id> --locale de
confx finish --session <id>
confx derive --session <id> --carry-defaults
```

Output is always JSON on stdout (`{data, notices}` or `{error}`). Exit codes: `0` success, `1` usage or value error, `2` invalid model or data, `3` not found or a version mismatch that needs `--force`, `4` finish refused, `5` session already finished. Sessions are stored in `--store`, `$CONFX_STORE`, or `./.confx/`.

## Development

Requirements: **Node.js ≥ 24** and **pnpm** (the version is pinned in `package.json` and selected via Corepack).

```sh
corepack enable
pnpm install
pnpm check        # typecheck, lint, test and build
```

| Script | Purpose |
|---|---|
| `pnpm typecheck` | TypeScript, no output |
| `pnpm lint` | ESLint, including the core boundary rule |
| `pnpm test` | All tests (Vitest) |
| `pnpm test:update` | Regenerate golden `expected.json` files (`UPDATE_GOLDEN=1`) |
| `pnpm build` | Compile `src/` to `dist/` with type declarations |
| `pnpm check` | All of the above |

Conventions:
- **Exact versions.** `.npmrc` sets `save-exact=true`. Add dependencies with `pnpm add -E`.
- **Core boundary.** Code in `src/core/` must not import Node built-ins (`fs`, `node:path`, …), use `process` or `Buffer`, or import the session layer or CLI. Lint enforces this, and `tests/boundary.test.ts` tests the rule itself.
- **Patched dependency.** `@marcbachmann/cel-js` 8.0.0 has a local patch (`patches/`, registered in `pnpm-workspace.yaml`) that fixes three signed-64-bit overflow gaps. See [`specs/cel-verification.md`](specs/cel-verification.md). The patch applies only in this repository, so it must be upstreamed or bundled before the first release.
- **TypeScript 6.** typescript-eslint doesn't support TypeScript 7 yet.

## Project layout

```
specs/
  MISSION.md              Normative specification (concepts, model format, evaluation, API, CLI)
  cel-verification.md     Findings and patch for the CEL library
src/
  core/                   Pure core (confx/core)
    contracts/            Zod schemas for all public outputs: state, result, audit, sessions
    errors.ts             ConfxError with typed codes and details
    version.ts            engineVersion, supported schema versions
  session/                Session layer (confx), currently re-exports the core
  cli/main.ts             CLI entry point (stub)
tests/
  golden/
    harness.ts            Golden-file test harness
    core/                 Core golden cases, one folder each (desk/, …)
  cel/                    Tests pinning CEL library behavior
  contracts.test.ts       Schema tests
  boundary.test.ts        Core boundary lint tests
patches/                  pnpm patches for dependencies
```

## Testing

**Golden-file tests** are the main test type. Each case is a folder:

```
tests/golden/core/<case>/
  model.yaml, i18n/*.yaml, data.json …   fixture files, passed to the core as strings
  steps.json                             ordered operations, e.g. [{"op": "evaluate", "args": {...}}]
  expected.json                          generated output, reviewed in the diff
```

- The harness runs each step, records `{op, ok, value}` or `{op, ok: false, error}`, and compares with `expected.json`.
- Output is JSON with sorted keys. Values JSON can't represent exactly (`bigint`, `-0`, `NaN`, `Infinity`, `undefined`) are tagged, e.g. `{"$bigint": "42"}`, so they never match by accident.
- Generate or update expectations with `pnpm test:update`, then **review the diff**. Never edit `expected.json` by hand. A case without `expected.json` fails unless you run the update.
- New operations are registered in `tests/golden/core/core.golden.test.ts` as work packages land. A session suite with a fake clock, ids and an isolated store follows in WP 8–9 and plugs into the same harness.

Other suites: library pinning (`tests/cel/`), contract schemas, and lint-boundary tests. The CLI will get a small separate suite for argument parsing and exit codes.

## Roadmap

From [`specs/MISSION.md` §9](specs/MISSION.md):

| WP | Scope | Status |
|---|---|---|
| 0 | Project setup, contracts, golden harness | ✅ done |
| 1 | Model schema and loader, `hashModel` | next |
| 2 | Expression engine (CEL environment, unknown, numeric helpers) | library verified ✅, engine open |
| 3 | Dependency graph, variable evaluation, sections, next-open-parameter | |
| 4 | Constraints, conflicts, taint, errors | |
| 5 | Localization | |
| 6 | Items, result, authoritative completion | |
| 7 / 7a | Model validator / tables | |
| 8 | Session layer foundations | |
| 9 | Session API, derivation, diffs | |
| 10 | CLI | |
| 11 | Model reference docs | |

**Milestone M1** (first end-to-end path): WP 0–4 and 6 with the validator parts they need, for models without tables. Then the session layer and the start/set/reset/state/lines/next/finish commands with their CLI commands.

## Documentation

- [`specs/MISSION.md`](specs/MISSION.md): the full normative specification, including the model format (§3), evaluation semantics (§4), sessions and versioning (§5), API and CLI (§6), validation checks (§7), and examples (§11).
- [`specs/cel-verification.md`](specs/cel-verification.md): pinned CEL library behavior, the local patch, and open questions.
