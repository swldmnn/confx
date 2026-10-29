# confX: Mission and Planning Base

## 1. Mission
confX is a generic, embeddable evaluation engine for configurable products (CPQ).
Product logic lives in a declarative YAML **model**. The engine holds no domain knowledge.
Every time a parameter changes, the engine re-evaluates the whole model and returns a consistent session state.

**Non-goals (v1):** UI, quote/offer documents, tax handling, mixed currencies, user management, multi-user concurrency (no session locking; concurrent writers to one session can lose updates, see 5), a database, a network server (the API is a library plus CLI first; a REST wrapper can come later).

## 2. Core Concepts
| Concept | Meaning |
|---|---|
| Model | YAML file with variables and rules. Immutable at runtime. |
| Session | One configuration run against one model. Persisted state = model reference plus user-provided inputs only. |
| Parameter | Value provided by the user (e.g. size). |
| Internal | Helper value used by rules (e.g. `basePricePerMaterial`). It is either a **constant** (its `default`, which the caller may override once at session start) or **calculated** by a rule from other variables (e.g. depends on the selected material) and then changes dynamically with its inputs. The caller never sets an internal after session start, and calculated internals cannot be overridden at all. |
| Output | Calculated value (e.g. price). It can never be set. |
| Rule | Expression that assigns a variable value or changes a variable attribute (`min`, `max`, `available`, `choices.<id>.available`). |
| Position | Template in the model that yields zero or one order line (article, quantity, unit price, data) in the **result** (see 3.8). Read-only on top of the state. |
| Result | Export format for external systems (e-shop): a list of items plus the total. Separate from the internal state, never an input to rules. |
| Table | Reference data declared in the model (columns and types) whose rows come from outside the model, e.g. a product data service (see 3.12). Rows are read-only for rules, can feed the choices of a parameter, and are pinned per session. |

**Key design principle:** session state is derived. Only the inputs (a set of parameter and internal values) and the pinned table data (3.12) are stored. The full state is recomputed by evaluating the model on every call. This keeps storage trivial and makes evaluation deterministic and testable: `evaluate` is a pure function of model, inputs and table data.

## 3. Model Specification (draft)

### 3.0 Model file: top-level keys
A model is one YAML file with these top-level keys. Unknown keys are a schema error (5.1).
| Key | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Integer, version of the model format (5.1). Read first, selects the schema. |
| `model` | no | Short model id (pattern as variable ids), informational, e.g. `desk`. Shown in session states and snapshots, not core State; never interpreted. |
| `modelVersion` | yes | Free-form label set by the author (5.1). Informational only. |
| `defaultLocale` | yes if `translations` is present | Fallback locale (3.7). Must be a key of `translations`. |
| `translations` | no | Map locale to translation file, relative to the model file (3.7). Without it the model has no texts and all ids fall back to themselves. |
| `sections` | no | List of sections (3.6). |
| `variables` | yes | List of variables (3.1). At least one. |
| `rules` | no | List of rules (3.2). |
| `pricing` | yes if `items` is present | Price settings of the result: `currency` and optional `pricePrecision` (3.8). |
| `items` | no | List of item templates (3.8). |
| `tables` | no | List of table declarations (3.12). Rows are not part of the model. |

Ids of variables, sections, items and tables share one namespace (3.1, 3.6, 3.8, 3.12). Reserved identifiers (3.3) cannot be used as such ids.

Tables (3.12, 11.2) are part of `schemaVersion: 1`, as is the name of the `pricing` key (previously `result`), because no engine supporting schemaVersion 1 has been released yet. After the first release, every format change bumps `schemaVersion` (5.1).

### 3.1 Variable fields
| Field | Notes |
|---|---|
| `id` | Unique in the model. Pattern `[A-Za-z][A-Za-z0-9_]*`, so it is usable in expressions. Reserved identifiers (3.3) are not allowed. |
| `kind` | `parameter`, `output`, `internal` |
| `type` | `int`, `float`, `string`, `bool`, `choice`. `bool` is allowed for all kinds. |
| `name`, `description` | Not stored in the model. Texts live in the translation files (see 3.7). Optional `nameKey` / `descriptionKey` override the translation id, otherwise it is derived from the variable id. |
| `section` | Optional id of a section the variable belongs to (see 3.6). Ungrouped variables sit at the top level. |
| `min`, `max` | int/float parameters only |
| `format` | string parameters only, regex |
| `precision` | float only, optional integer n from 0 to 12 inclusive. Calculated values of the variable (and its `min`/`max` rule results) are rounded to n decimals. See 3.4. |
| `choices` | choice only: list of `{id, nameKey?}`. Choice ids match `[A-Za-z][A-Za-z0-9_]*` and are unique within the variable, not across the model. They contain no dots or commas. Texts come from the translation files (3.7). Value is the choice id. Mutually exclusive with `choicesFrom`; a choice variable declares exactly one of them. |
| `choicesFrom` | choice parameters only: `{table, when?, textColumn?}`. The choices are the rows of a table (3.12); a choice id is the row key. |
| `multiple` | choice only, bool. Value is a list of choice ids. |
| `mandatory` | parameters only, default false |
| `default` | Required for a constant internal; optional for a calculated internal or parameter. Internal: the constant value, or the selection fallback of a calculated internal (3.2). Parameter: a starting suggestion, see 3.5. |
| `order` | Optional number. Defines the "next open parameter" sequence among its siblings, see the order rules in 3.6. Without it, declaration order applies after all siblings with `order`. |

**Allowed fields and rule targets per kind.** A field outside this matrix is a validator error. Declaration fields:
| Field | parameter | internal | output |
|---|---|---|---|
| `id`, `kind`, `type`, `section` | yes | yes | yes |
| `min`, `max` (int/float) | yes | no | no |
| `format` (string) | yes | no | no |
| `precision` (float) | yes | yes | yes |
| `choices`, `multiple` (choice) | yes | yes | yes |
| `choicesFrom` (choice) | yes | no | no |
| `mandatory` | yes | no | no |
| `default` | optional | required if constant; optional selection fallback if calculated | no |
| `order` | yes | no | no |
| `nameKey`, `descriptionKey` | yes | yes | yes |

Rule targets:
| Target | parameter | internal | output |
|---|---|---|---|
| `<id>` (assign value) | no (inputs only) | yes (makes it calculated) | yes (required, at least one rule) |
| `<id>.min`, `<id>.max` (int/float) | yes | no | no |
| `<id>.available` | yes | no | no |
| `<id>.choices.<c>.available` | yes (static `choices` only) | no | no |

Consequences:
- **Only parameters have constraints and availability.** They exist to check and shape user input. Internals and outputs are computed values, so they are never unavailable, and there is no "unavailable output". An author who wants a value to disappear conditionally models that in the items (`when:`) or with a guard on the rule that assigns it.
- `precision` applies to all kinds: it rounds calculated values, and the `min`/`max` rule results of a parameter (3.4).
- `choices` on an internal or output declares the allowed result ids of a calculated choice value. A rule result outside the list is an evaluation error (4.6).
- `format`, `choices`, `choicesFrom` and `multiple` are static: they are not rule targets (3.5). The rows behind `choicesFrom` are table data, not model content (3.12).
- `mandatory` affects completion and question flow (`getNextOpenParameter`); `order` affects question flow. Both are parameter-only.

**Value semantics per type** (what "set" means and how values are checked):
- **`format` (string):** a JavaScript `RegExp` (with the `u` flag, no other flags) that must match the **whole** value. The engine wraps the pattern with an absolute start and strict end-of-input assertion, e.g. `^(?:<pattern>)(?![\s\S])`, not a trailing `$` that can match before a final newline. Thus `[A-Z]{3}` means exactly three capital letters and rejects `"ABC\n"`; authors do not need anchors. An invalid regex is a validator error. A mismatch is a conflict of kind `pattern_mismatch`.
- **String parameters:** the empty string is a **value**, it counts as set (for `mandatory`, `has(set.x)`). Authors who need non-empty input declare `format: ".+"`, so an empty string becomes a `pattern_mismatch` conflict.
- **Multiple choice (`multiple: true`):**
  - The value is a list of choice ids in the order given, without duplicates. A duplicate id in an input is a wrong-value error (exception, 4.7), not a conflict.
  - An **empty list counts as unset** (not set for `mandatory`, no entry in `set`). Setting `[]` is the same as `resetParameter`.
  - There are no count limits in v1 (`min`/`max` are int/float only). Authors who need "at most 2" cannot express it yet.
  - `default` is a non-empty list of valid choice ids, without duplicates (validator).
  - Checks are per selected id: an id that is not in `choices` is a conflict of kind `invalid_choice`, an id that is currently unavailable is a conflict of kind `unavailable`. Both conflicts carry `choice: <id>` (3.9), so several selected ids give several conflicts.
- **`precision` and constants:** `precision` rounds values the engine **calculates** (rule results, and the `min`/`max` results of a parameter, 3.4). A constant internal's `default` is not calculated, so it is never rounded: the validator requires it to have at most `precision` decimals (error otherwise). A constant internal overridden at start is an input, and inputs are never rounded (3.4).

**Input/default validation by kind:** a constant internal (one without assigning rules) must declare a default; omitting it is a model validation error, not a required startup argument. Calculated internals may omit defaults and then become unknown when no rule supplies a value. Defaults must match their declared type and satisfy applicable static constraints and declared choice membership. Explicit inputs are validated as follows:

| Case | Parameter | Constant internal |
|---|---|---|
| No default | Allowed; may remain unset | Invalid model |
| Wrong-type explicit input | Reject | Reject |
| Undeclared choice id | Retain as `invalid_choice` conflict | Reject |
| Parameter constraint violation | Retain as conflict | Not applicable |
| Statically invalid default | Invalid model | Invalid model |

All float inputs must be finite numbers (`NaN` and infinities are invalid); all integer inputs must be safe integers. `null` is invalid for every kind and type and is never an input reset marker. Multiple-choice inputs must be arrays of strings without duplicates; mixed-type arrays are wrong-type errors. For parameters, `[]` means reset/unset as above. Constant-internal multiple-choice defaults and overrides must be nonempty and contain only declared choice ids. These rules apply to start and explicit derive overrides; invalid explicit values are rejected, not silently dropped or coerced. Inputs are never rounded, including constant-internal overrides; precision restrictions on declared constant defaults and calculated rounding remain unchanged.

### 3.2 Rule forms
```yaml
rules:
  - id: price_calc                  # optional, generated as `<target>#<n>` if omitted (3.9)
    target: price                   # assign value (output/internal only)
    expr: size * pricePerUnit
  - target: size.min                # constrain attribute (size is int, so the result must be int)
    expr: 'int(double(minBySeries) * 1.5)'
  - target: coating.available       # conditional availability
    expr: material == "steel"
  - target: color.choices.red.available   # per-choice availability
    expr: material != "wood"             # choice 'red' not selectable for wood
  - target: basePricePerMaterial          # internal calculated by rule
    expr: 'material == "oak" ? 1.2 : 1.0'
  - id: max_steel                         # guarded rules: first match wins
    target: width.max
    when: material == "steel"
    expr: '160'
  - id: max_default                       # unguarded rule = default, must be last for its target
    target: width.max
    expr: '200'
```
`expr` and `when` must be YAML strings. A non-string value (e.g. the number `160`) is a schema error, not coerced, so the author always writes a CEL expression explicitly. The result of a `min`/`max` rule must match the variable's type (`int` or `float`), with no implicit conversion (strict typing, see 3.3).
An internal with an assigning rule is calculated. Its `default` is the fallback when no rule matches or rule selection is undecidable because a guard is unknown. It never replaces an unknown or errored selected expression, or an errored guard. An unguarded rule does not necessarily make the default unreachable: an earlier unknown guard can still trigger fallback. Warn about an unused default only when selection fallback is unreachable (e.g. the sole assigning rule is unguarded).

**Multiple rules per target, first match wins.** A target is a variable value or an attribute (`min`, `max`, `available`, `choices.<id>.available`). A target may have several rules, each with an optional boolean `when:` guard.
1. Rules are tried in declaration order. The first rule whose guard is true is the active rule, and only its `expr` is evaluated.
2. A rule without `when:` always matches. It acts as the default and must be the last rule for its target. A rule after an unguarded rule is unreachable, which is a validator **error**.
3. Overlapping guards are allowed (that is the point of first-match), and there is no overlap warning.
4. No active rule: the target falls back to the static declaration (no constraint, declared `min`/`max`, available). For an internal the declaration is its `default`. For an output there is none, so the value is `unknown`. The validator warns if an output, or an internal without `default`, has only guarded rules.
5. At the first guard that evaluates to `unknown`, stop selection: no later guard or expression is evaluated. Fall back to the static declaration (an internal's default if present, otherwise unknown for a value target), mark the target `undecided`, and set `active: null`. A selected expression that is unknown also makes the target `undecided`, but keeps the selected rule id in `active`: attributes fall back to their static declaration, while value targets remain unknown without using an internal default. Example: `width` with declared max 200 stays capped at 200 when either rule selection or the selected max expression is unknown. CEL short-circuiting still applies inside expressions and guards.
6. A guard that is not a bool or that errors stops selection and reports an evaluation error for that rule (4.6). The value target is errored with a null value and no internal-default fallback; an attribute uses its static declaration while reporting the error. No rule was selected, so `active` is null. A selected expression error keeps the selected rule id in `active`, makes a value target errored, and falls back to the static declaration for attributes. In both cases the target status is `error`.
There is no combining of constraints. Authors needing several limits at once write one expression (e.g. `min(a, b)`).

**Normative rule outcome table:** “static” means the declared attribute value (no bound if omitted; availability true by default). “Internal fallback” means the internal's declared default, if any; outputs never have a default. Only actual evaluation errors emit error diagnostics; unknowns do not.

| Outcome | Value target | Attribute target | Target status | `active` | Value `source` |
|---|---|---|---|---|---|
| All guards false | Internal fallback, otherwise unknown | Static | `ok` | null | `default` if fallback exists, otherwise `none` |
| First unresolved guard unknown | Internal fallback, otherwise unknown | Static | `undecided` | null | `default` if fallback exists, otherwise `none` |
| Guard errors or returns non-bool | Error, null; no fallback | Static plus error | `error` | null | `none` |
| Selected expression unknown | Unknown, null; no fallback | Static | `undecided` | Selected rule id | `rule` |
| Selected expression errors | Error, null; no fallback | Static plus error | `error` | Selected rule id | `rule` |
| Selected expression succeeds | Calculated value | Calculated attribute | `ok` | Selected rule id | `rule` |

A value supplied by an internal fallback has variable status `known`; a missing fallback has status `unknown`. A value-target evaluation error has variable status `error`. Attribute-rule outcomes do not replace a parameter's input/default source. Error diagnostics retain the id of the failing rule even when its guard failed and `active` is null. Constant internals without assigning rules are outside this selection table and retain `source: constant` for their declared default or `source: input` for a start override.

### 3.3 Expression language
**Decided:** CEL (Common Expression Language) via `@marcbachmann/cel-js` (pinned version). No custom parser, no `eval`.
- Syntax is plain CEL: arithmetic, comparison, `&&`, `||`, `!`, ternary `cond ? a : b` (there is no `if()`), `in` for lists and multi-choice.
- Custom functions registered by the engine: `min`, `max`, `round`, `abs`, with exactly the signatures and semantics of 3.4. If the library provides built-ins with these names but other semantics, the engine overrides them. There is no `isSet()` function, see "Presence map" below.
- Variables are declared in the CEL environment by their model type, so expressions are statically type-checked by `validateModel` (`env.check()`).
- **Type mapping:** `int` is CEL `int` (`bigint`), `float` is `double` (`number`), `string` is `string`, `bool` is `bool`, a single `choice` is `string` (the choice id), and a `multiple` choice is `list<string>`. `set` is a `map` (see below).
- **Choice id literals are checked (best effort):** the validator scans the AST for comparisons of a choice variable with a string literal (`material == "oka"`, `material != "x"`, `"oka" in material`, `material in ["a", "b"]`). A literal that is not one of the variable's choice ids is a validator **error**, because the comparison can never be true and is almost certainly a typo. Comparisons with non-literals cannot be checked.
- Typing is strict, as in CEL: `int` values are `bigint`, `float` values are `number`, and mixing them needs an explicit conversion (e.g. `double(width) * 1.5`). The engine converts input and output values according to the declared type. See also numeric semantics (3.4).
- **`unknown` semantics:** an unset variable is left out of the evaluation context. CEL evaluates normally, so short-circuiting works (`false && unsetVar` is `false`, `true || unsetVar` is `true`). If the missing variable is actually needed, the library throws `EvaluationError` "Unknown variable: <name>". The engine catches this and the result is `unknown`. Other evaluation errors (division by zero, type mismatch) are reported as errors, not as `unknown`.
- **Presence map:** a plain function `isSet(x)` cannot work, because CEL evaluates its argument first and an unset `x` throws before the function runs. Instead the engine passes a map variable `set` (declared as `map`) in the context. It has an entry `<id>: true` for every variable that currently has a value, and no entry for the others. Authors write `has(set.x)`, which is plain CEL, uses public library API only, and short-circuits like any other expression (`has(set.x) && x > 3` is `false` when `x` is unset).
  - "Has a value" means: set by the user, set by a default (3.5, a defaulted parameter counts as set, consistent with `mandatory`), a constant internal, or calculated to a known value. An `unknown` or errored variable has no entry.
  - `set` is a reserved identifier and cannot be a variable, section, position or table id.
- **Reserved identifiers:** no variable, section, item or table id may equal a name that the engine or CEL binds, because it would shadow it in the CEL environment. The closed v1 list: `set` (presence map), `row` (row binding of `choicesFrom.when`, 3.12), the engine functions `min`, `max`, `round`, `abs`, the CEL keywords and literals (`true`, `false`, `null`, `in`, `as`, `break`, `const`, `continue`, `else`, `for`, `function`, `if`, `import`, `let`, `loop`, `package`, `namespace`, `return`, `var`, `void`, `while`), the CEL type names (`int`, `uint`, `double`, `string`, `bool`, `bytes`, `list`, `map`, `type`, `null_type`, `dyn`), the library's global namespaces (`cel`, `google`, `optional`; verified in WP 2, see `cel-verification.md`), and the CEL built-in functions and macros (`size`, `has`, `all`, `exists`, `exists_one`, `map`, `filter`, `matches`, `contains`, `startsWith`, `endsWith`, `timestamp`, `duration`). If the pinned library binds further global names, they are added to this list in WP 2. A reserved id is a validator error (`invalid_id`).
  - The `set` map is untyped, so `check()` cannot catch typos like `has(set.widht)`. The validator scans the AST for `set.<name>` accesses and reports a name that is not a variable id as an error. Dynamic access such as `set["x"]` is also checked when the key is a literal, and anything else is rejected.
  - Detection of the missing-variable error relies on the library's error type and message. Pin the library version and cover this with a test.
- Unknown for `available` rules means the declared availability (available by default), until the guard or expression is known to be false (see 3.2 rule 5).
- **Tables in expressions:** every declared table is bound under its id as a `map<string, Row>` (3.12), e.g. `products[product].basePrice`, `product in products`, `size(products)`. A lookup with a key that has no row behaves like an unset variable: the result is `unknown`, not an error (detected via the library's missing-key error, pinned and tested like the missing-variable error). Authors guard with `key in table` where needed.

### 3.4 Numeric semantics
- `int` is exact (`bigint` in CEL). `float` is an IEEE double. There is no decimal type in v1.
- Comparisons are exact. There is no epsilon or hidden tolerance. Authors get stable comparisons through rounding.
- **`precision: n`** on a float variable: every calculated value of that variable, and the results of its `min`/`max` rules, are rounded to n decimals, so downstream rules, guards and constraint checks see the rounded value.
- **`round(x, n)`** is a registered custom function for explicit rounding in expressions. It uses the same mode as `precision`.
- **Precision limits:** variable `precision` is an integer from 0 to 12 inclusive; result `pricePrecision` is an integer from 0 to 6 inclusive (default 2). Out-of-range declaration values are model validation errors. The `n` argument of `round` must be a CEL int from 0 to 12 inclusive; an out-of-range argument is an evaluation error. These limits bound decimal processing.
- **Numeric helper signatures:** `min(int, int) -> int`, `min(double, double) -> double`, `max(int, int) -> int`, `max(double, double) -> double`, `abs(int) -> int`, `abs(double) -> double`, and `round(double, int) -> double`. `min`/`max` are binary in v1. There is no implicit int/double conversion. Integer overflow (including `abs` of signed-64-bit minimum) and non-finite numeric results are evaluation errors. Register or reuse library helpers only with these semantics.
- **Rounding mode:** half away from zero, implemented on the decimal string representation of the double (avoids artifacts such as `1.005` rounding down). `Number.prototype.toString` returns exponent forms for very small and very large values (`1e-7`, `1.5e-7`, `1e21`). The implementation first expands these into plain decimal digit strings and then rounds on the digits, so rounding never depends on the exponent form. The result `-0` is normalized to `0`. `NaN` and infinities are evaluation errors on that target. Golden cases cover `1.005`, `2.5`, `-2.5`, `1e-7`, `1.5e-7`, `1e21` and `-0.4` with `precision: 0`.
- User-entered values are never rounded. Inputs are stored as given, so the audit record is exact.
- Floats are for dimensions, weights and prices at normal scale, not for exact accounting. Values that are compared (thresholds, guards, constraints) should be rounded or declared with `precision`.
- **Integer limits:** two limits apply and both are documented for authors. (1) The engine's CEL-int contract is signed 64-bit arithmetic; overflow is an evaluation error (4.6), not a wrap. Verify the pinned CEL library's literals, conversions and arithmetic at both signed boundaries before evaluator implementation. Adapt unsupported behavior to this contract or reject it explicitly; never assume conformance or silently weaken the limit. (Verified in WP 2: three gaps are fixed by a local package patch, and an int literal above `2^63 - 1` is a validator error unless it is `2^63` directly under unary minus; see `cel-verification.md`.) (2) The engine's serialization limit is tighter, see the next point. An integer input outside the safe range is rejected when it is set (wrong-value exception, 4.7), so it never enters a session. Conversions like `double(i)` for `|i| > 2^53` lose precision as usual for doubles.
- **Serialization:** all exported `int` values, including variables, item quantities and integer data entries, must be within the safe range (+-(2^53 - 1)). Outside it, report an evaluation error at the originating variable/item field rather than losing precision. `float` values are JSON numbers after applicable precision rounding. Monetary exports additionally satisfy the exact minor-unit round-trip checks in 3.8.
- **Later evaluation item:** a `decimal` type (custom CEL type with operator overloads, e.g. backed by `decimal.js`). The trigger is a model that cannot be written cleanly with `precision`. A spike would first test whether the CEL library supports custom types and operator overloads. It is a new `type` value, so it can be added without breaking existing models.

### 3.5 Defaults and internals after start
- **Parameter `default`** is a starting suggestion, not an input. An unset parameter with a default evaluates as if set to the default, and the state marks it `source: default`. The default is not stored in the session inputs, so unfinished sessions follow the model's default, and the snapshot at `finish` freezes it.
  - It counts as set for `mandatory` and `getNextOpenParameter`. Authors who want explicit confirmation should not declare a default.
  - `resetParameter` returns the parameter to its default (or to unset if there is none).
  - The default must satisfy the static constraints (validator).
  - **Rejected defaults:** the validator only checks static constraints, so a default can still be unusable at runtime: the parameter is unavailable, or the default violates a dynamic constraint (a rule-computed `min`/`max`, a `choices.<id>.available` rule). The default is then **not used**: the parameter evaluates as unset, for downstream rules, items and `mandatory`. It is not a conflict, because the user set nothing, so it does not block `finish` by itself (a mandatory parameter left unset still does). It is never silent: the variable carries `defaultRejected: {reason, ruleId}` (`reason`: `unavailable`, `out_of_range`, `pattern_mismatch`, `invalid_choice`, same vocabulary as conflict kinds), and the state lists it in a `warnings` entry `{variable, kind: "default_rejected", reason, ruleId}`. The default is re-checked on every evaluation, so it is used again as soon as it becomes valid.
- **Internals:** a constant internal can be overridden once at `startSession` / `deriveSession` and is then fixed for the session. Calculated internals cannot be overridden (initial values for them are rejected). There is no `setInternal` / `updateInternal` in v1. To change an internal, start a new session with `deriveSession` and different initial values. A `setInternal` can be added later without breaking anything.
- **`choices` is not a rule target.** The choice list is static. Rules may only change `choices.<id>.available`. For a `choicesFrom` parameter the list follows the table data, and availability comes from the row filter `choicesFrom.when` (3.12).

**Raw inputs and effective values:** stored user inputs are separate from the values exposed to expressions. An unavailable parameter's raw input is retained for state display and conflict reporting, but has no effective value. A parameter default becomes an effective value only if availability and all applicable constraints permit it. Rules, guards, items and the `set` presence map all observe the same effective values; there is no provisional/raw-value expression context. The dependencies needed to decide effective presence are part of the model graph (4.1). Feedback through availability or default rejection is a validator error, not resolved by iteration.

### 3.6 Sections
Sections group parameters (and optionally outputs and internals) for presentation and for the question order. They have no influence on evaluation.
```yaml
sections:
  - {id: dimensions}
  - {id: material_options, parent: dimensions, order: 20}   # optional nesting
variables:
  - {id: width, kind: parameter, type: int, section: dimensions, ...}
```
- A section has `id`, optional `parent` (another section id, giving a tree), optional `order` (number, sibling order, see the order rules below) and optional `nameKey` / `descriptionKey` (see 3.7).
- A variable belongs to at most one section via `section: <id>`. Variables without a section are top level.
- Section ids use the variable id pattern and share the id namespace with variables, so they cannot clash in rule targets or translation ids.
- Sections are static in v1: no `available` rule target. A section with no available parameter is simply empty, and consumers may hide it. (Possible later addition: `<sectionId>.available`.)
- `getNextOpenParameter` walks the section tree depth first. **Order rules:** among siblings (variables of one section, child sections of one section, top-level variables, top-level sections), entries **with** `order` come first, sorted ascending (ties: declaration order), followed by entries **without** `order` in declaration order. Within a section its own variables come first, then its child sections. At the top level, variables without a section come before top-level sections.
- State output carries the section tree: `sections: [{id, nameKey, descriptionKey, parent, variables: [ids], children: [...]}]` (locale-free, `localize` adds `name` / `description`, 3.7). The `variables` map keeps the flat form and adds `section` per variable.
- Validator: section ids unique, `parent` and `section` references exist, no parent cycle.

### 3.7 Translations
All human-readable text lives in **one file per locale**, outside the model logic. The model contains no inline texts.
```
desk/
  model.yaml
  i18n/
    en.yaml
    de.yaml
```
```yaml
# model.yaml
defaultLocale: en
translations:            # locale -> file, relative to the model file
  en: i18n/en.yaml
  de: i18n/de.yaml
```
```yaml
# i18n/de.yaml (flat map: translation id -> text)
material.name: Material
material.description: Werkstoff der Platte
material.choices.oak: Eiche
material.choices.steel: Stahl
width.name: Breite
dimensions.name: Abmessungen
```
**Translation ids** are either derived from ids (default) or set explicitly:
| Text | Derived id (default) | Explicit override |
|---|---|---|
| Variable name | `<variableId>.name` | `nameKey` |
| Variable description | `<variableId>.description` | `descriptionKey` |
| Choice name | `<variableId>.choices.<choiceId>` | `nameKey` on the choice |
| Table choice name (3.12) | none, the row's `textColumn` value is used as is (not translated) | `textColumn` on `choicesFrom` |
| Section name / description | `<sectionId>.name` / `<sectionId>.description` | `nameKey` / `descriptionKey` |
| Position name / description | `<positionId>.name` / `<positionId>.description` | `nameKey` / `descriptionKey` |
| Position data text | none, always explicit | `textKey` expression in the `data` entry (3.8) |

Overrides allow one text to be shared (e.g. several variables using `common.width`).
- **Resolution:** requested locale, then `defaultLocale`, then the id (the derived or explicit key itself) as a last resort. The fallback is reported by `localize` (the `fallbacks` list, 3.9), not as an error.
- **Core stays pure:** `loadModel(yamlText, translations)` takes the translation file contents as `{locale: yamlText}`. The `ModelSource` (session layer) reads the files listed under `translations`. The core never touches paths.
- **Hashes:** `hashModel` returns two hashes. `logicHash` is the integrity hash of **all non-text model content**, not only evaluation logic: the parsed model document minus the top-level keys `translations` and `defaultLocale` and each table's `source` path, before schema defaults are injected. Informational model id/version, section order and translation-key overrides remain in scope; changing them requires model-change acceptance. Omitted and explicitly written defaults hash differently. `textHash` covers `defaultLocale` plus all translation contents and locale ids, excluding paths; exact canonical encoding is specified in section 8. Adding/removing a locale changes only textHash; re-pointing a locale changes textHash only if its contents change. The finish snapshot embeds the model and translations for audits. A translation fix never blocks a session. Table rows are not model content and are covered by a separate `dataHash` (3.12); table declarations are model content and part of `logicHash`, except each table's `source` path, which is removed before hashing.
- **Locale is not an input of evaluation:** `evaluate` and `buildResult` are locale-free. They emit translation ids (`nameKey`, `descriptionKey`, choice keys, `{textKey: <id>}` data entries), never texts, and report no locale fallbacks. A separate pure function `localize(model, stateOrResult, locale) -> localized` resolves the ids to texts (resolution above), adds `name` / `description` fields next to the ids, and reports the fallbacks it applied (requested locale to `defaultLocale` to id). Texts are presentation, never inputs to rules, and are not stored in sessions. The session layer's `getState` / `getOrderLines` take an optional `locale` and call `localize` on the result.
- **Validator:** every declared locale file is parsed, and the `defaultLocale` must be declared. **Required texts** are the names of parameters, outputs, sections, items and static choices. Choices from tables need no translation ids (3.12), and tables themselves have no texts. Descriptions are always optional, and **internals need no texts** (they are helper values), so they never produce missing-text warnings. A missing required text per locale is a warning. For `defaultLocale` a missing name is a warning too, because the id fallback applies. Unused translation ids are warnings, which catches typos and renamed ids. To avoid false positives for ids used by dynamically built `textKey` expressions (3.8), only ids in the **derived-id namespace** are checked: an id whose first segment is a declared variable, section or position id (`width.nmae` next to a declared `width`) but which matches no derived or explicit key. Free-form ids with any other first segment (`info.premium`, `common.width`, or the misspelled undeclared prefix `widht.name`) are never reported as unused. An id counts as used if it is derived from a declared id, set as `nameKey` / `descriptionKey`, or appears as a string literal in a `textKey` expression.
- Because the texts left the model, adding or fixing a translation, adding a locale, or changing `defaultLocale` does not change `logicHash` (the keys `translations` and `defaultLocale` are excluded from it, see "Hashes"). It only changes `textHash` (state flag `textsChanged`, informational, see 5.1).

### 3.8 Positions and result (order lines)
The **state** is for internal processing. The **result** is for external systems, e.g. mapping to e-shop order items. One authoritative `evaluate` pipeline evaluates variables, constraints and items, including result arithmetic, before computing completion. `buildResult` (6.1) formats the already evaluated outcomes; it never evaluates expressions again. Items cannot be referenced by rules and do not feed back into variable evaluation, but their outcomes contribute to completion.
```yaml
pricing:
  currency: EUR          # one currency per model, no mixing
  pricePrecision: 2      # optional integer 0..6, default 2, rounding as in 3.4
items:
  - id: frame                         # always present (no guard)
    article: frameArticle             # CEL expression, type string
    price: 'double(width) * pricePerCm'   # unit price, CEL float
    data: {taxClass: '"standard"'}    # enrichment, see below
  - id: premium_handle
    when: handle == "premium"         # guard, same semantics as 3.2
    article: premiumHandleArticle     # internal variable (constant or rule-calculated)
    quantity: 'int(sashCount)'        # optional, CEL int, default 1
    price: premiumHandlePrice
```
**Position fields**
| Field | Notes |
|---|---|
| `id` | Unique. Shares the id namespace with variables and sections (translation ids). |
| `when` | Optional boolean guard. False: no position. `unknown`: position is listed with status `undetermined`. Non-bool or error: evaluation error. Only a true guard (or omitted guard) evaluates remaining fields; unknown/errored guards skip them. |
| `article` | Required. CEL expression of type string, typically an internal variable holding the article number, or an expression selecting between articles. Article numbers are defined by the model, never by the engine. |
| `quantity` | Optional, CEL int, default 1. Must be >= 1, otherwise an evaluation error. |
| `price` | Required. CEL float, **unit price**, rounded to `pricePrecision` before multiplying by quantity. Negative values (discounts) are allowed. |
| `data` | Optional map `key -> entry`. An entry is either a CEL expression (value is string, int, float or bool; a string literal needs inner quotes, e.g. `'"standard"'`) or a **text entry** `{textKey: <CEL string expression>}`. A text entry evaluates the expression to a translation id. The locale-free result carries the id (`{"textKey": "info.premium"}`), and `localize` turns it into the text for the requested locale (3.7: locale, then `defaultLocale`, then the id itself). This is how data that does not come from user choices (tax class, delivery class, shop category, informational text, ...) reaches the external system. Plain expressions are never translated. Example: `note: {textKey: 'isPremium ? "info.premium" : "info.standard"'}`. Entries are optional enrichment: ordinary unknown values serialize as null without making the item incomplete. Expression errors or actually needed failed dependencies make the item error and block finishing; missing translations are localization fallbacks, not evaluation errors. No per-entry required flag in v1. |
| `nameKey` / `descriptionKey` | Texts via the translation files (3.7), derived ids `<positionId>.name` / `<positionId>.description`. Informational text is therefore localized like everything else. |

**Independence from sections and parameters:** items have their own list. One parameter may produce several items, several parameters may produce one, and an item may exist without any user choice. The premium handle example: `premium_handle` is its own item with its own article, present only if `handle == "premium"`. If the standard handle is also an article, a second item `standard_handle` with the opposite guard lists it.

**Result shape** (`getOrderLines`):
```json
{
  "status": "final | provisional",
  "currency": "EUR",
  "items": [
    {"id": "premium_handle", "status": "ok", "article": "WIN-HND-PRM", "nameKey": "premium_handle.name", "descriptionKey": "premium_handle.description",
     "quantity": 2, "unitPrice": 39.00, "total": 78.00,
     "data": {"taxClass": "standard"}, "origin": ["handle", "sashCount"], "tainted": false}
  ],
  "total": 498.00,
  "conflicts": [], "errors": []
}
```
`buildResult` returns this locale-free form. `localize` adds `name` / `description` next to the keys and replaces `{"textKey"}` data entries with texts.
- **Order and conditional inclusion:** declaration order of `items`. A false guard omits the item entirely and skips evaluation of its other fields; it introduces no item blocker. True guards evaluate the item's fields. Unknown guards list the item as `undetermined`; errored guards list it as `error`. Both skip remaining fields and block finishing. A guard that actually needs a failed dependency is an error under 4.6, not an ordinary unknown. An omitted guard means true. Optional products therefore need no special optional-item field: e.g. a bool parameter `includeHandle` with `default: false` and an item with `when: includeHandle` omits the handle until selected. If `includeHandle` has neither an input nor a default, inclusion is unresolved and finishing is blocked.
- **`origin`:** derived by the engine from the dependency graph, not authored. It lists the parameters the position (guard, article, quantity, price, data) transitively depends on. Like taint, it is static (4.4): it lists every parameter reachable in the graph, including ones a short-circuited branch did not actually use. For traceability only.
- **Rounding and exact multiplication:** round each unit-price expression to `pricePrecision` first, half away from zero (3.4). Convert that rounded decimal to integer minor units directly from its decimal digits, without binary floating-point multiplication by a scale. Multiply by the integer quantity using bigint to get the line total in minor units. Sum line totals using bigint; the result total is this sum and nothing else. Convert only for checked JSON export. Thus at precision 2, unit expression 1.005 and quantity 2 export unitPrice 1.01 and line total 2.02, not 2.01. Negative prices use the same algorithm. No binary floating-point line multiplication or accumulation is used.
- **Supported monetary exports:** each rounded unit price, line total and aggregate total must have absolute minor-unit value <= `Number.MAX_SAFE_INTEGER`. Before exporting as a JSON number, verify that its decimal representation (expanding exponent notation when needed) converts back to exactly the same minor-unit integer at `pricePrecision`; reject nonrepresentable values rather than silently changing minor units. Normalize negative zero to zero. Compute intermediate products/sums as bigint, then check every exported value. Unit-price or line-total overflow/nonrepresentability is an item error (`field: price` or `field: total`); aggregate overflow/nonrepresentability is an error at `result:total`. Such failures produce a null affected total and block finishing; all checks run inside authoritative evaluation before completion.
- **Total is the single source of truth for the price.** There is no separate overall price output: prices live in the required item `price` expressions, and the result `total` is their sum. A missing item price is a schema error, not a warning.
- **Position status:** false guards omit the item. Unknown guards produce `undetermined`, and errored guards produce `error`; both skip other fields, whose scalar values and total are null, with declared data keys represented as null entries. For a true/omitted guard, evaluate fields and use precedence `error` > `incomplete` > `ok`. Any field (including data/textKey expressions) that errors or actually needs a failed dependency makes the item `error`. Otherwise an unknown article, quantity or price makes it `incomplete`; ordinary unknown data alone does not. Unknown fields serialize as null. If any listed position is not `ok`, the result `total` is null, never a silent partial sum. Unknown optional data on an otherwise ok item does not invalidate its price or the result total.
- **Data completeness and diagnostics:** known plain data values and known translation keys are preserved. Ordinary unknown data/textKey expressions produce null entries and do not block finish. Originating item errors identify `field` and, for data entries, the exact `dataKey` (3.9); failed dependencies reuse their originating diagnostics (4.6). Missing translation text only triggers localization fallback. There is no per-data-entry required flag in v1: required commercial information belongs in required item fields or is enforced through mandatory inputs.
- **Result status:** `final` for a finished session, `provisional` otherwise (passed to `buildResult` by the session layer, 3.9). Finishing requires all listed items to be `ok` and result arithmetic to have succeeded, so a final result has no unresolved listed items or missing total. All items may be omitted by definitively false guards; an empty selection is not itself a blocker. A provisional result is a preview and must not be used to create an order. `getOrderLines` is allowed at any time.
- **Taint and conflicts:** a listed item is `tainted` if its guard or any field expression statically depends on an available conflicting value (4.4), including references in branches not evaluated on this run. Hidden conflicting inputs do not seed downstream taint. Omitted false-guard items have no result entry to flag. The result carries the evaluation's conflicts and errors, including item errors already collected in state.
- **Snapshot:** `finish` stores the locale-free result in the snapshot (5.2). A finished session is served from the snapshot and localized on request.
- **Reserved for later:** repeating items (e.g. `forEach` over a multi-choice parameter, or an `article` on a choice as shorthand). Not in v1. Adding either needs a `schemaVersion` bump (5.1).

### 3.9 State and result schema (normative)
This is the normative documentation of the output shapes. 6.2 and §10 refer to it. Golden tests pin it down. At implementation time, Zod runtime schemas are the source of truth for model and public output contracts; TypeScript types are inferred from those schemas. The TypeScript-style definitions below document the required shapes, not a separate type-to-schema generation mechanism. Every output of the core is **locale-free** (3.7): texts appear as ids (`*Key`), and `localize` adds the text fields listed at the end.

**Enums:**
| Enum | Values |
|---|---|
| `VariableStatus` | `known` (has a value), `unset` (parameter without value or usable default), `unknown` (derived value not decidable, e.g. missing input or undecided output), `error` (evaluation error, 4.6) |
| `VariableSource` | `input` (user or start value), `default` (parameter default or calculated-internal selection fallback), `constant` (constant internal at its default), `rule` (selected value rule, including an unknown or errored expression), `none` |
| `TargetStatus` | `ok`, `undecided` (guard or `expr` `unknown`, 3.2 rule 5), `error` |
| `ConflictKind` | `out_of_range`, `pattern_mismatch`, `unavailable`, `invalid_choice` |
| `PositionStatus` | `ok`, `undetermined`, `incomplete`, `error` (3.8) |
| `ResultStatus` | `final`, `provisional` |
| `SessionStatus` | `unfinished`, `finished`. This says only whether `finish` ran. Whether it can run is `completion.canFinish`. |

**State** (the `state` member of the core `Evaluation` returned by `evaluate`):
```ts
type Id = string;                       // variable, section or position id
type TargetId = string;                 // "<id>" | "<id>.min" | "<id>.max" | "<id>.available" | "<id>.choices.<c>.available" | "<id>.choices" (row filter of choicesFrom, 3.12)
type Value = number | string | boolean | string[] | null;   // int/float -> number, multiple choice -> string[], unknown -> null

interface State {
  variables: Record<Id, VariableState>;
  targets: Record<TargetId, TargetState>;     // targets with at least one rule, plus every `<id>.choices` row-filter target of a choicesFrom parameter that declares `when` (3.12)
  sections: SectionState[];                    // tree, 3.6
  conflicts: Conflict[];
  errors: EvalError[];
  warnings: Warning[];
  completion: { canFinish: boolean; blockers: Blocker[] };
}

interface VariableState {
  id: Id; kind: "parameter" | "output" | "internal"; type: "int" | "float" | "string" | "bool" | "choice";
  section: Id | null; nameKey: string; descriptionKey: string;
  value: Value; status: VariableStatus; source: VariableSource;
  multiple: boolean;                          // true only for choice variables declared multiple; false otherwise
  mandatory: boolean;
  available: boolean;                          // effective availability, always true for internals and outputs (3.1)
  min: number | null; max: number | null;      // effective bounds, null = none (always null for internals and outputs)
  choices?: { id: Id; nameKey: string | null; label?: string; available: boolean }[];   // table choices (3.12): nameKey null, label = textColumn value if declared
  choicesFrom?: Id;                            // table id for choicesFrom parameters (3.12)
  tainted: boolean; errorDerived: boolean;     // target-level propagation aggregated for display, 4.4 and 4.6
  defaultRejected?: { reason: ConflictKind; ruleId: string | null };   // 3.5
}

interface TargetState {
  rules: string[];                             // rule ids in declaration order
  active: string | null;                       // selected rule id, even if its expr is unknown/errored; null if no rule selected
  status: TargetStatus;
}

interface SectionState {
  id: Id; nameKey: string; descriptionKey: string; parent: Id | null;
  variables: Id[]; children: SectionState[];
}

interface Conflict   { variable: Id; choice: Id | null; kind: ConflictKind; ruleId: string | null; causedBy: Id[]; root: boolean }   // 4.4, `choice` is set for per-id conflicts of multiple choice (3.1)
interface EvalError  { target: TargetId | `position:${Id}` | "result:total"; ruleId: string | null; message: string; field?: "when" | "article" | "quantity" | "price" | "total" | "data" | "bounds"; dataKey?: string } // originating errors only; dataKey only with field data
type Warning =
  | { variable: Id; kind: "default_rejected"; reason: ConflictKind; ruleId: string | null }   // 3.5
  | { variable: Id; kind: "no_available_choice" };   // 3.12: available mandatory choice parameter without any available choice
type Blocker =
  | { kind: "open_mandatory"; ref: Id }
  | { kind: "conflict"; ref: Id; conflictIndex: number }
  | { kind: "error"; ref: EvalError["target"]; errorIndex: number }
  | { kind: "position"; ref: `position:${Id}`; status: "undetermined" | "incomplete" };
```
- **Rule ids:** explicit rule ids match `[A-Za-z][A-Za-z0-9_]*` and are globally unique across rules. A rule without id gets `<target>#<n>` (n = its 1-based position among all rules of that target, including explicitly named rules). Explicit ids cannot contain `#`, so generated ids cannot collide with them; generated ids are unique by target and position. Rule ids are separate from the shared variable/section/item namespace. Every ruleId and active is a string or null.
- **`canFinish`:** true if all mandatory available parameters have a value, there are no conflicts or relevant errors (4.6), every listed position is `ok`, and result arithmetic succeeded. `blockers` lists the reasons (the `finish` refusal in 6.2 returns the same list). Each `undetermined` or `incomplete` position contributes a `position` blocker referencing `position:<id>`; position errors contribute error blockers. False-guard items are omitted and do not block finishing. Models without items retain the ordinary mandatory-input, conflict and error checks. Ordinary unknown optional item data does not block finishing; data-expression errors or actually needed failed dependencies do.
- **Model validator warnings** are a separate list (section 7) and are not part of the state. `warnings` here are runtime warnings only.
- **Exact blocker references:** conflictIndex/errorIndex are zero-based indexes into the same state's conflicts/errors arrays; ref must equal the referenced conflict's variable or error's target. Emit one error blocker per relevant originating error, not per dependent item. Mandatory blockers follow question traversal order (3.6), then conflict blockers in conflict-array order, error blockers in error-array order, and unresolved-position blockers in item declaration order. Finish refusal copies these blockers exactly. Indexes are response-local, not persistent diagnostic ids.

**Session state** (`getState`, session layer) adds the session context around the same shape:
```ts
interface SessionState extends State {
  sessionId: string; model: string | null; status: SessionStatus; modelVersion: string;
  flags: { modelChanged: boolean; engineChanged: boolean; textsChanged: boolean };   // 5.1
  acceptedChanges: AcceptedChange[];                                                  // 5.1
  data: DataIdentity | null;                                                          // pinned table data, null if the model declares no tables (3.12)
  dataChanges: DataChange[];                                                          // 3.12
}
```
A finished session returns the snapshot's state in this shape. `completion` of a finished session is `{canFinish: true, blockers: []}`.

**Result** (core output of `buildResult`, 3.8):
```ts
interface Result {
  status: ResultStatus; currency: string | null; // null only when no `pricing` is declared
  items: ResultPosition[];
  total: number | null;                        // null if any listed position is not ok or aggregate arithmetic/export fails
  conflicts: Conflict[]; errors: EvalError[];  // copied from the state
}
interface ResultPosition {
  id: Id; status: PositionStatus;
  article: string | null; nameKey: string; descriptionKey: string;
  quantity: number | null; unitPrice: number | null; total: number | null;
  data: Record<string, string | number | boolean | { textKey: string } | null>;
  origin: Id[]; tainted: boolean; errorDerived: boolean;
}
```
`evaluate(model, inputs, data) -> Evaluation` (`data` is the validated table data, 3.12; `{}` for models without tables) returns an immutable evaluation object whose public `state` member has the shape above. It also retains the evaluated position outcomes, checked totals and internal effective-value/dependency metadata needed by the pipeline and result formatting. These internal members are not session-state fields or persisted live state. The compiled model owns the dependency graph and expression metadata; rules and items use the same effective-value representation, never a context reconstructed from displayed state values or `value !== null`.

`buildResult(model, evaluation, status)` projects the evaluated position outcomes and totals into `Result`, copying conflicts and errors from `evaluation.state`. All item-expression and result-arithmetic errors have already been collected there before completion is computed. Formatting introduces no new evaluation errors. `status` comes from the caller's context: the session layer passes `final` only for an evaluation that can finish and is being snapshotted, otherwise `provisional`; finished reads use the stored final result. Requesting `final` for an evaluation that cannot finish is an invalid API argument. The function remains pure and does not rerun CEL or result arithmetic.

**Empty results:** models without items still produce a Result with items [] and total 0. Currency is null if `pricing` is absent, otherwise the declared currency. Declaring items, even [], requires `pricing` under 3.0. If every declared item is omitted by false guards, items is [] and total is 0 with the declared currency. An aggregate error still makes total null under the arithmetic policy; no implicit currency is invented.

**Localized form** (`localize`, 3.7): the same objects, plus `name` and `description` next to every `nameKey` / `descriptionKey` (variables, choices, sections, items), `name` = `label` for table choices with a label (otherwise the choice id, without a fallback entry), `{textKey}` data entries replaced by the resolved text, and a top-level `fallbacks: {key: Id; requested: string; usedLocale: string | null}[]` (`null` = the id itself was used).

### 3.10 Session command responses and exceptions (normative)

All session-layer commands return `SessionResponse<T>`; the payload descriptions in 6.2 refer to data inside this envelope. Core functions remain unwrapped and pure. Notices are command-level observations, separate from runtime state warnings, model-validation diagnostics and localization fallbacks.

```ts
interface SessionResponse<T> { data: T; notices: SessionNotice[] }
type SessionNotice =
  | { kind: "texts_changed"; fromHash: string; toHash: string }
  | { kind: "engine_version_changed"; fromVersion: string; toVersion: string }
  | { kind: "data_changed"; fromHash: string; toHash: string; dataVersion: string | null };   // 3.12, refresh with changed rows

interface StartData { sessionId: string; state: SessionState }
type FinishData =
  | { finished: true; state: SessionState; result: Result }
  | { finished: false; state: SessionState; blockers: Blocker[] };
interface DeriveData {
  sessionId: string; state: SessionState;
  droppedInputs: DroppedInput[];
  diff: SessionDiff | null;
  baselineUnavailable: BaselineUnavailable | null;
  flags: { modelChanged: boolean; engineChanged: boolean };
}
interface ValidationData { valid: boolean; diagnostics: ValidationDiagnostic[] }
```

Command data: start returns StartData; set/reset/state return SessionState; lines returns Result; next returns the full VariableState of the next open parameter or null; derive returns DeriveData; validate returns ValidationData. State/lines with a locale return the localized form inside data. Finish returns FinishData: refusal is a normal response, not an exception, and its blockers exactly equal state.completion.blockers. A successful finish returns finished state and the final result; a second finish throws session_finished. Audit, dropped-input, diff and diagnostic contracts are defined in 3.11.

Text notices accompany a newly observed text-hash difference; minor/patch engine notices accompany a newly observed version difference under 5.1. Return notices in that order if both occur. Validation without a session returns notices []; finished reads return notices [] and textsChanged false, retaining historical model/engine flags from the snapshot. Transient notices are not persisted as session history or replayed from snapshots. Snapshot state records textsChanged false; a finish response can still report a just-observed text change and its notice. Derive notices describe observations made while loading its source baseline, without updating the source's observed metadata; repeated derivations may therefore observe the same difference again.

**Typed exceptions:** library failures use ConfxError with code, message and optional JSON-serializable structured details. Do not require callers to parse messages. The closed v1 code list and CLI mapping are:

| Code | Meaning | CLI exit |
|---|---|---|
| `invalid_usage` | CLI argument/JSON parse failure | 1 |
| `invalid_argument` | Invalid option combination or invalid API operation/argument | 1 |
| `unknown_variable` | Explicit input/set/reset references an unknown id | 1 |
| `wrong_value` | Wrong type/domain or invalid explicit constant-internal value | 1 |
| `no_snapshot` | Requested embedded snapshot/default carrying without a snapshot | 1 |
| `model_invalid` | Model or translation parsing/schema/semantic errors | 2 |
| `unsupported_schema_version` | Model format version is not supported | 2 |
| `session_not_found` | Session does not exist | 3 |
| `model_not_found` | Path-backed model file does not exist | 3 |
| `model_source_error` | Other model-source I/O failure | 3 |
| `model_changed` | Logic-hash mismatch requiring force | 3 |
| `data_invalid` | Table data does not match its table declaration (3.12) | 2 |
| `data_source_error` | Table data could not be loaded (missing file, service failure) | 3 |
| `engine_changed` | Engine-major mismatch requiring force | 3 |
| `incompatible_inputs` | Stored inputs cannot be accepted, even with force | 3 |
| `session_finished` | Attempt to mutate/finish an already finished session | 5 |
| `storage_error` | Session-store read/parse/write failure | 1 |
| `internal_error` | Unexpected failure, sanitized for public output | 1 |

CLI exception output is `{error: {code, message, details?}}`, not a successful data envelope; omit details when absent. Never include a stack trace in this JSON. Finish refusal uses the normal response envelope and exit 4. Validate returns diagnostics with valid false and exit 2 for model-invalid/unsupported-schema cases rather than throwing those validation failures; source I/O failures still throw. Code-specific detail shapes are defined in 3.11.

### 3.11 Audit, diff and diagnostic contracts (normative)

```ts
type Timestamp = string; // valid UTC ISO-8601, exactly YYYY-MM-DDTHH:mm:ss.sssZ
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type InputDefinition = {
  kind: "parameter" | "internal";
  type: "int" | "float" | "string" | "bool" | "choice";
  multiple: boolean;
};
type ModelReference =
  | { kind: "path"; path: string }
  | { kind: "embedded"; model: string; translations: Record<string, string> };
interface VersionIdentity { logicHash: string; modelVersion: string; engineVersion: string }
interface AcceptedChange { at: Timestamp; from: VersionIdentity; to: VersionIdentity }
interface SourceChange { at: Timestamp; from: ModelReference; to: ModelReference }
interface DataIdentity { dataHash: string; dataVersion: string | null; loadedAt: Timestamp }   // 3.12
interface DataChange { at: Timestamp; from: DataIdentity; to: DataIdentity }               // 3.12
type DerivedFrom = null | {
  sessionId: string; mode: "current" | "embedded" | "path"; sourceLogicHash: string;
};
type StructuralInputReason = "unknown_variable" | "kind_changed" | "type_changed";
type InputIncompatibilityReason = StructuralInputReason | "invalid_choice";
interface InputIncompatibility { variable: Id; reason: InputIncompatibilityReason }
interface DroppedInput {
  variable: Id; value: Value; source: "input" | "carried_default";
  reason: InputIncompatibilityReason;
}
interface BaselineUnavailable {
  kind: "incompatible_inputs";
  inputs: InputIncompatibility[];
}

interface Change<T> { before: T; after: T }
interface EntityChange<T> { id: string; before: T | null; after: T | null }
interface ListDelta<T> { added: T[]; removed: T[] }
interface StateDiff {
  variables: EntityChange<VariableState>[];
  targets: EntityChange<TargetState>[];
  sections: Change<SectionState[]> | null;
  conflicts: ListDelta<Conflict>;
  errors: ListDelta<EvalError>;
  warnings: ListDelta<Warning>;
  completion: Change<State["completion"]> | null;
}
interface ResultDiff {
  items: EntityChange<ResultPosition>[];
  itemOrder: Change<Id[]> | null;
  currency: Change<string | null> | null;
  total: Change<number | null> | null;
  conflicts: ListDelta<Conflict>;
  errors: ListDelta<EvalError>;
}
interface SessionDiff { state: StateDiff; result: ResultDiff }
```

**Audit and transfer rules:** all session/snapshot/audit times use Timestamp and the injected clock. Input definitions, model references and source/acceptance histories use the exact types above. Dropped input values are the original entire values, never coerced or partially filtered; source distinguishes stored inputs from carried parameter defaults. Sort dropped/incompatible input records by variable id using UTF-16 code-unit order. If several incompatibilities apply, use precedence unknown_variable, kind_changed, type_changed, invalid_choice. Explicit overrides supersede copied candidates before these diagnostics (5.3). DerivedFrom records sourceLogicHash from the source snapshot or accepted stored session baseline, even when current source-model loading yields an unavailable comparison baseline; mode is path for explicit modelPath, embedded for explicit useEmbeddedModel, current otherwise. Derive comparison flags compare that accepted source identity with the target: modelChanged compares logicHash, engineChanged compares engineVersion majors. They are distinct from the new session's initially empty acceptance history.

**Diff rules:** diffState/diffResult return the respective types above. Compare locale-free evaluated objects structurally, using canonical JSON equality (8), not raw input maps or object-key insertion order. Variable changes include full evaluated values, status, source, availability, constraints and flags; target/item changes include their complete public entities. Emit only changed entities, sorted by id using UTF-16 code-unit order; null before/after means absence, never an entity with an unknown value. Both-null and identical before/after entries are invalid. Whole sections, completion, item order, currency and total return null if unchanged, otherwise before/after. List deltas cancel structurally equal occurrences and preserve the original before order for removals and after order for additions. All fields are always present, using empty arrays/deltas or null for no change. Ignore session metadata (ids, timestamps, histories, change flags/notices, data identity and dataChanges), localization fields/fallbacks, and result final/provisional status. Item ordering is compared explicitly, not inferred from entity sorting. Dropped inputs remain a separate DeriveData member, not duplicated in SessionDiff. A normal derive response has a non-null diff and baselineUnavailable null; only the approved incompatible-input baseline exception returns diff null with a non-null diagnostic (5.3), including constant-internal invalid_choice.

```ts
type ValidationCode =
  | "yaml_parse" | "schema" | "unsupported_schema_version"
  | "duplicate_id" | "invalid_id" | "invalid_field" | "invalid_default" | "invalid_regex"
  | "invalid_reference" | "invalid_expression" | "expression_type" | "invalid_choice_literal"
  | "dependency_cycle" | "section_cycle" | "unreachable_rule"
  | "guarded_without_fallback" | "unused_default" | "missing_translation"
  | "unused_translation" | "translation_file" | "unused_internal"
  | "invalid_table" | "unused_table";
interface DataIssue {
  table: Id; row: number | null; key: string | null; column: string | null;   // row = zero-based row index
  reason: "not_a_list" | "not_an_object" | "missing_column" | "unknown_column" | "wrong_type"
        | "non_finite" | "unsafe_integer" | "empty_key" | "duplicate_key" | "unknown_table" | "missing_table";
}
interface ValidationDiagnostic {
  severity: "error" | "warning"; code: ValidationCode;
  source: "model" | "translation"; locale: string | null;
  path: (string | number)[];
  message: string; line: number | null; column: number | null;
}
type WrongValueReason =
  | "wrong_type" | "null" | "non_finite" | "unsafe_integer"
  | "duplicate_choice" | "invalid_choice" | "empty_choice_list";
interface ErrorDetails {
  invalid_usage: { argument: string | null; reason: string };
  invalid_argument: { argument: string; reason: string };
  unknown_variable: { variable: Id };
  wrong_value: { variable: Id; value: JsonValue; receivedType: string; reason: WrongValueReason };
  no_snapshot: { sessionId: string; operation: "embedded" | "carry_defaults" };
  model_invalid: { diagnostics: ValidationDiagnostic[] };
  unsupported_schema_version: { declared: number; supported: number[] };
  session_not_found: { sessionId: string };
  model_not_found: { path: string };
  model_source_error: { path: string; operation: "read" };
  model_changed: { stored: VersionIdentity; current: VersionIdentity };
  data_invalid: { issues: DataIssue[] };
  data_source_error: { table: Id | null; reason: string };
  engine_changed: { stored: VersionIdentity; current: VersionIdentity };
  incompatible_inputs: { inputs: InputIncompatibility[] };
  session_finished: { sessionId: string; operation: "set" | "reset" | "finish" };
  storage_error: { sessionId: string | null; operation: "load" | "save" | "delete" };
  internal_error: never;
}
type ErrorCode = keyof ErrorDetails;
type ErrorPayload = {
  [C in ErrorCode]: { code: C; message: string; details?: ErrorDetails[C] }
}[ErrorCode];
```

**Validation/exception rules:** valid is true exactly when diagnostics contain no error severity. Codes are stable machine-readable categories corresponding to section 7; message wording is not an API discriminator. Structural schema failures use schema, forbidden/invalid YAML uses yaml_parse, and semantic checks use the specific category above. Translation content errors have source translation and its locale; model diagnostics have source model and locale null. Paths are relative to that document (numeric components are zero-based list indexes); line/column are 1-based when available, otherwise null. Sort diagnostics by source (model first), locale, canonical-JSON path, code, severity and message using code-unit order. A ConfxError's details, when present, must match its code-specific schema; internal_error never exposes details. Invalid values that cannot be represented in JSON (e.g. NaN, infinity, bigint, undefined or cyclic input) use value null in wrong_value details, with receivedType/message describing the rejected value; this is diagnostic encoding, not accepted input or coercion.

**Deterministic runtime diagnostic ordering:** conflicts follow variable declaration order, then kind order out_of_range/pattern_mismatch/unavailable/invalid_choice, then selected-choice input order for per-id entries (null first). Errors sort by target, field (absent first), dataKey (absent first), ruleId (null first), then message using code-unit order. Runtime warnings follow variable declaration order then reason order as for conflict kinds. Origin parameter lists use variable declaration order with ids deduplicated. Blockers use the ordering defined in 3.9 after these arrays are finalized. Derivation, finish refusal and copied result diagnostics refer to these same finalized arrays.

### 3.12 Tables (reference data)
Tables bring external reference data (e.g. from a product data service: article ids, base prices, stock) into the evaluation without making it model content. The **model declares** a table's shape; the **rows are data**, supplied from outside, validated against the declaration, pinned per session and embedded in the snapshot. The core stays pure: it receives the rows as an argument and never fetches anything.

**Declaration:**
```yaml
tables:
  - id: products                  # shares the id namespace (3.0)
    key: articleId                # name of the key column, always type string
    columns:
      - {id: basePrice, type: float}
      - {id: availableQuantity, type: int}
      - {id: label, type: string}
    source: data/products.yaml    # optional default file, relative to the model file
```
| Field | Notes |
|---|---|
| `id` | Table id, variable id pattern, shared namespace with variables, sections and items. |
| `key` | Name of the key column (identifier pattern). The key is a non-empty string and unique within the table. It has **no** identifier restriction, so real article ids like `4711-00` or `A.12/3` are allowed. |
| `columns` | Non-empty list of `{id, type}`. Column ids use the identifier pattern, are unique per table and differ from `key`. `type` is `int`, `float`, `string` or `bool`. Every row has every column; there are no nullable columns in v1. |
| `source` | Optional default data file, relative to the model file. It contains the table's row list (YAML or JSON, same restricted parsing as section 7). A `DataSource` supplied by the caller replaces it (below). |

**Data shape and validation.** Data for a model is `Record<TableId, Row[]>`, a row being an object with the key column and exactly the declared columns. The session layer validates data before evaluation: every declared table is present, no undeclared tables, values match their column types (finite floats, safe integers, as for inputs in 3.1), keys are non-empty and unique. Violations throw `data_invalid` with all issues (3.11); data is never coerced or partially accepted. An empty table (no rows) is valid. Data values are never rounded (like inputs, 3.4). Row order is preserved and is the choice order of `choicesFrom`.

**Access in expressions (3.3).** A table is bound in the CEL environment under its id as `map<string, Row>`, `Row` being a typed object with the declared columns, so `products[product].basePrice` type-checks to `double`. A missing key yields `unknown` (not an error), `key in products` tests presence, and the usual CEL macros work (`products.exists(k, products[k].availableQuantity > 0)`). Table data is constant during one evaluation: tables are **not** nodes of the dependency graph (4.1), create no taint or `errorDerived`, never appear in `origin` and are not in the `set` presence map. Table ids cannot be rule targets.

**Choices from a table (`choicesFrom`).** A choice parameter can take its choices from a table:
```yaml
  - {id: product, kind: parameter, type: choice, mandatory: true,
     choicesFrom: {table: products, when: 'row.availableQuantity > 0', textColumn: label}}
```
- **Choice list:** one choice per row, in row order; the choice id is the row key. `multiple: true` is allowed.
- **Availability filter `when`:** an optional CEL bool expression evaluated once per row, with `row` bound to the row (typed like the table's `Row`) and access to model variables and tables. A row whose filter is `false` stays in the choice list with `available: false`, so a selected product that runs out of stock becomes an `unavailable` conflict and stays traceable, exactly like a static choice switched off by a rule (4.5). `unknown` means available (3.3). A non-bool or erroring filter is an evaluation error at target `<id>.choices` (message names the row key) and that row falls back to available, like an erroring `available` rule (4.6). Without `when` every row is available.
- **Target and dependencies:** the filter is one attribute target `<id>.choices` with no `rules`/`active` (both empty/null in `TargetState`). It is always listed in `targets` when `when` is declared. Its `status` is `error` if the filter errors for any row, otherwise `undecided` if it is `unknown` for any row, otherwise `ok`. Variables referenced in `when` create edges into this node, exactly like `<id>.choices.<c>.available` rules (4.1), including the default-validation dependency of the parameter's value node and the cycle policy (`when` referencing the parameter itself is a cycle).
- **Per-choice rules:** `<id>.choices.<c>.available` targets are not allowed on a `choicesFrom` parameter, because choice ids are unknown at validation time. All availability logic lives in `when`. `<id>.available`, `mandatory`, `default` and `order` work as for every parameter.
- **Texts:** `textColumn` names a string column whose value is the choice's display label (`label` in `VariableState`, 3.9). Labels are data, not translated, and need no translation ids. Without `textColumn` the choice id is shown. Missing texts for table choices are never reported by the validator.
- **Values and conflicts:** a selected key without a row is an `invalid_choice` conflict (per id for multiple choice). The value stays visible to expressions if the parameter is available (4.3), and table lookups with it yield `unknown`. A parameter `default` cannot be checked statically against rows; a default without a row, or on an unavailable row, is rejected at runtime with reason `invalid_choice` / `unavailable` (3.5). Choice-literal checks (3.3) do not apply.
- **No selectable choice:** if an available, mandatory `choicesFrom` parameter is unset and no row is available, the state carries the runtime warning `{variable, kind: "no_available_choice"}` (3.9). The parameter stays an open mandatory blocker, so `finish` is refused. Clients use the warning to tell users "nothing can be configured right now" instead of showing an empty question.
- `choicesFrom` is parameter-only in v1. Calculated internals and outputs that need a key use a `string` type and table lookups.

**Data lifecycle in sessions.** Table data is pinned per session so that every command evaluates against the same rows until an explicit refresh:
- **Loading:** the session layer obtains data from a `DataSource` interface, `load(model, {sessionId, reason}) -> {tables: Record<TableId, Row[]>, dataVersion: string | null}`. `reason` is `start`, `refresh` or `derive`. The default `DataSource` reads each table's `source` file, resolved relative to the model file; this works only for path-backed model sources. An embedded model source (5) has no file location, so the default `DataSource` cannot resolve `source` for it: such sessions need an injected `DataSource`, explicit file overrides or `keepData` (derive), otherwise loading throws `data_source_error`. An embedding application injects its own `DataSource` (e.g. a client of the product data service). Per call, the caller can override files per table with the `dataFiles` option (`Record<TableId, path>`, paths resolved against the working directory; CLI `--data <table>=<file>`, 6.3); a table without an override uses the `DataSource`. Overrides apply only to the call that supplies them and are **not persisted**: a later refresh without overrides loads from the `DataSource` again. A missing table source or failing service throws `data_source_error`, invalid rows throw `data_invalid`. Nothing is saved on failure.
- **Pinning:** `startSession` loads, validates and stores the data in the session file together with `DataIdentity {dataHash, dataVersion, loadedAt}`. `dataHash` is the SHA-256 of the canonical JSON (8) of `{<tableId>: [rows in data order]}` for all declared tables; `dataVersion` is an optional label from the `DataSource` (e.g. a price list version) and informational only; `loadedAt` comes from the injected clock. Ordinary commands evaluate against the stored rows and never contact the `DataSource`.
- **Refresh:** any command that loads an unfinished session accepts `refreshData: true` (`--refresh-data`). The data is loaded again and validated before the command runs. If `dataHash` changes, a `DataChange {at, from, to}` is appended to `dataChanges` and the response carries a `data_changed` notice. An unchanged hash appends nothing (a new `dataVersion` alone is stored but not audited). Inputs are never touched: a selected product that disappeared or ran out becomes a normal `invalid_choice` / `unavailable` conflict, and new prices show up in the result. Callers that require current data at order time refresh in the `finish` call (`finishSession(id, {refreshData: true})`). If that finish is refused, the refreshed data, its `DataIdentity` and any `dataChanges` entry are still saved (5.1), so the reported `data_changed` notice matches the stored session; only the finish itself is not applied.
- **Model changes:** a changed table declaration (`id`, `key`, `columns`) changes `logicHash` and follows 5.1. The `source` path is excluded from `logicHash`, like translation paths: rows are covered by `dataHash`, so moving a data file never requires `force`. Accepting it with `force` re-validates the stored data against the new declaration; if the stored data no longer fits, acceptance fails with `data_invalid` unless `refreshData` supplies fitting data in the same command. A rejected command leaves the session unchanged.
- **Snapshot:** `finish` embeds the pinned data, its `DataIdentity` and `dataChanges` in the snapshot (5.2), so audits show exactly which prices and stock were used.
- **Derivation (5.3):** `deriveSession` loads **fresh** data for the target by default (the re-evaluation use case "prices may have changed"). With `keepData: true` (`--keep-data`) the source's pinned data (snapshot data for a finished source) is copied instead, which reproduces the original evaluation; keeping data that does not fit the target's table declarations throws `data_invalid`. The diff then shows price and availability changes as changed values, items, conflicts and totals. The new session starts with empty `dataChanges`.
- Table data is not an input: it is never part of `inputs`, `inputDefinitions` or `initialValues`, and `set`/`reset` cannot change it.

**Limits.** Filters run once per row and evaluation, and lookups are map accesses. v1 targets catalogs of up to a few thousand rows per table. Large catalogs should be pre-filtered by the `DataSource` (e.g. by product family) instead of being loaded in full.

## 4. Evaluation Semantics
These rules define how the model is evaluated. Variable-side stages are implemented in WP 3–4; WP 6 integrates item outcomes and authoritative completion. Golden tests pin down each stage and the complete pipeline.
1. **Dependency graph:** build a DAG from the variables referenced in each rule expression. Evaluate in topological order. A cycle is a model error (found by `validate`).
   - **Nodes are targets, not variables:** `x` (effective value), `x.min`, `x.max`, `x.available` and `x.choices.<c>.available` (or the row-filter node `x.choices` for a `choicesFrom` parameter, 3.12). Tables are evaluation constants, not nodes. Raw parameter inputs are stored separately and are not the value nodes referenced by expressions.
   - **Effective-value dependencies:** every parameter value node depends on its `available` node. If the parameter declares a `default`, its value node also depends on its `min`, `max` and per-choice availability nodes where applicable, because those attributes can reject the default. Static constraints are checked too, but introduce no variable dependencies. Without a default, bounds and per-choice availability affect conflict checking, not effective presence: an available user's conflicting value remains visible to expressions.
   - **Edges:** a rule's target node depends on the nodes of every variable its `when` and `expr` reference. A reference to variable `x` in an expression means the **value** node of `x`. Attributes are never referenced directly from expressions. A `set.x` access (presence map, 3.3) counts as a reference to the value node of `x`, so `has(set.x)` creates the same edge as `x` itself.
   - **Cycle policy:** include effective-value dependencies and all candidate rules' references when validating the graph. The graph is built from the model, independent of current inputs: a parameter with a default keeps its default-validation dependencies even when a user input currently overrides that default. Reject every cycle in this expanded graph; there is no fixed-point iteration or provisional evaluation phase. In particular, `x.available` referencing `x` or `has(set.x)` is invalid, as is `x.max` referencing `x` when `x` declares a default.
   - **Why target-level nodes still matter:** with neither parameter declaring a default, `width.max` depending on `material` while `material.choices.oak.available` depends on `width` is acyclic, although a variable-level graph would suggest `width <-> material`. Adding defaults can introduce real feedback through default rejection, in which case the expanded graph correctly rejects the model.
   - Positions and the result sit on top of the variable graph and are never dependencies of variable targets (3.8). Their expressions consume the same effective values, and their outcomes are evaluated before authoritative completion is computed.
2. **Unset inputs:** a rule that references an unset parameter produces `unknown` (null propagation). It is not an error. Outputs depending on unset inputs are `unknown`.
3. **Constraint application:** evaluate attribute and effective-value nodes in the expanded graph's topological order. Before exposing a parameter's effective value, resolve its availability and, if it declares a default, all attributes required for default validation. Reject an unusable default before dependent expressions run. Validate retained user inputs against the effective constraints for conflict reporting; do not hide an available user input merely because it violates a bound or choice constraint. No expression observes a provisional default that is later removed in the same evaluation.
   - **Runtime bound consistency:** after resolving both effective bounds (including precision rounding and static fallback), check `min <= max` when both exist. If violated, report one originating evaluation error with `target: <parameterId>`, `field: "bounds"` and `ruleId: null`. The message includes both bounds; contributing rule provenance remains available in the min/max target states. Keep the computed bounds visible; never swap, clamp or discard them. Treat this as a constraint-check error, not a value-node error: the parameter's retained user value and source/status remain unchanged and downstream rules still see it if available. Error relevance follows 4.6; this check is relevant for an available parameter, or if a relevant target depends on its bound consistency (including default validation).
   - **Impossible-range input handling:** do not additionally emit an `out_of_range` conflict for a user value against an inconsistent pair of bounds. Other conflicts still apply. A declared parameter default is rejected against an impossible range, becoming unset with `defaultRejected: {reason: "out_of_range", ruleId: null}` and the corresponding runtime warning. For a consistent range, emit at most one `out_of_range` conflict per parameter (below min or above max), using the violated bound's active rule id or null for a static bound.
4. **Conflicts:** a set value that violates its effective constraints (out of range, regex mismatch, unavailable, invalid choice) is reported as a **conflict**. The value is kept, not silently dropped. The session cannot be finished while conflicts exist (root and cascaded alike): `completion.canFinish` is false (3.9).
   - **Constraints are always applied exactly as computed**, even if computed from a conflicting value. Taint is information on top, never a reason to suppress or alter a constraint.
   - **Taint seeds:** a conflicting variable is itself marked `tainted: true`. If its parameter value is available, its effective-value node also seeds downstream taint. An unavailable conflicting raw input does not seed downstream taint because it is absent from the effective context. This exclusion concerns the hidden conflict as a seed, not unrelated taint arriving through other graph dependencies.
   - **Target-level propagation:** taint follows the expanded dependency graph (4.1) transitively, including attribute dependencies and references in guards. Dependence is **static**: include every reference in every candidate rule's `when` and `expr`, not just the selected rule or branches actually evaluated. Thus `false && x` can be tainted by an available conflicting `x`. This intentionally over-approximates influence within the effective-value semantics; it requires no dynamic CEL tracing. Values and constraints still evaluate normally. Dynamic tracking is a possible later refinement, not a v1 requirement.
   - **Variable aggregation:** public `tainted` is true if the variable has a conflict or any of its value/attribute targets is tainted, including per-choice availability targets. This is display aggregation only and creates no graph edges. A tainted `width.max` does not automatically taint calculations reading `width`: propagation into the effective-value node occurs only through actual graph edges (e.g. default-validation dependencies). Internal target flags are retained during evaluation even though `TargetState` does not expose them. Consumers decide how to present taint.
   - **Items:** use the same static propagation policy over guard and all field expressions, including unused branches and transitive dependencies through all candidate variable rules. False-guard items are omitted. `origin` remains the full static reachable parameter list, independent of availability, selection, conflicts and whether a branch ran; it is not filtered by taint-seed exclusions.
   - **Conflict shape:** `{variable, choice, kind, ruleId, causedBy, root}`. `choice` is the selected choice id for per-id conflicts of a multiple choice (3.1), otherwise `null`.
     - `kind`: `out_of_range`, `pattern_mismatch`, `unavailable`, `invalid_choice`.
      - `ruleId`: the selected rule that successfully produced the violated constraint, or `null` if the effective constraint comes from the static declaration (including unknown/error expression fallback despite a non-null active rule).
      - `causedBy`: ids of other conflicting variables the violated constraint statically depends on (transitively, via the dependency graph, including all candidate rules and unused branches). Exclude the conflict's own variable and exclude unavailable conflicting raw inputs as influence seeds, consistently with taint (4.4–5). Deduplicate ids and order them by variable declaration order. This denotes potential influence, not proof that changing any one listed variable will resolve the conflict.
      - `root`: true exactly when `causedBy` is empty. This is a presentation flag only. The conflict-provenance graph need not be acyclic even though the evaluation graph is a DAG: reciprocal constraints on available user inputs without defaults can produce mutual `causedBy` references. A nonempty conflict list may therefore contain no root conflicts. Clients must display all conflicts, not assume every conflict chain reaches a root. Cascaded conflicts are never suppressed. No cyclic-group/SCC output fields are added in v1.
5. **Unavailable parameters:** they are not required for completion even if mandatory.
   - A value set by the user on an unavailable parameter is reported as a conflict of kind `unavailable` and kept (it is user input). The state still shows the user's value (`source: input`) together with the conflict. For downstream evaluation (rules, guards, items, `set` presence map) it is treated as **unset**, so a hidden parameter cannot influence the rest of the model. The conflict still blocks `finish` until the user resets the value or it becomes available again.
   - A **default** on an unavailable parameter is not used and not a conflict. It is reported as a rejected default (3.5), so it stays traceable.
   - Taint (4.4) follows the same rule: the unavailable conflicting variable is itself tainted, but its hidden raw input does not seed downstream taint. References to it still remain in static dependency metadata and item `origin`.
6. **Evaluation errors:** division by zero, type mismatch, a guard that is not a bool, an int outside the safe range and similar errors are reported per target (with the rule id) and do not crash the session. An error is not `unknown`: it is a separate outcome with its own status.
   - **Value of an errored target:** a value target gets status `error` and value `unknown` (null). For `min`/`max`/`available`/`choices.<id>.available` an error means the effective attribute falls back to the static declaration, the same as an `unknown` guard (3.2 rule 5). The error is reported, so the problem stays visible.
   - **Propagation:** every target whose evaluation transitively depends on an errored target gets `errorDerived: true`. Dependencies are the static graph edges (4.1), including references in all candidate rules and unused branches. The dependent evaluates normally with an errored value left out of the effective context (like `unknown`), so it becomes `unknown` only if it actually needs the value, and short-circuiting still applies. `errorDerived` is information only and never suppresses a constraint. A target's own error does not by itself set its `errorDerived`; that flag requires dependency on another errored target. A public variable's flag is the logical OR of its value/attribute targets' flags, including per-choice availability, for display only. Aggregation creates no extra propagation edges. Listed items apply the same dependency-derived flag over their guard and field expressions; their own field error alone does not set it.
   - **Actual missing-error causes:** retain internal cause metadata separately from static `errorDerived`. When CEL reports a missing variable that was actually needed, distinguish an unset input from an errored value or a derived unknown whose actual missing-value cause traces to an originating error. Carry those originating-error references through dependent unknowns. Do not infer this cause from `errorDerived` alone: an unused errored branch can set that static flag without preventing calculation. This uses the missing-variable failure actually encountered, not dynamic tracing of all CEL references. Attribute fallback that supplies a usable static value is not itself a missing value.
   - **Dependent outcomes:** a value target that actually needs a failed dependency remains `unknown` with internal originating-error references, rather than producing a new error diagnostic. A listed item whose guard or any field, including optional data/textKey expressions, actually needs a failed dependency is `error`, not merely `undetermined`/`incomplete`; a successful short-circuit remains successful even if `errorDerived` is true. Needing an ordinary unset value remains ordinary unknown; optional data then serializes as null without making the item incomplete.
   - **Error shape:** `{target, ruleId, message, field?, dataKey?}` (3.9). Originating item-expression errors include the field (`when`, `article`, `quantity`, `price` or `data`), and data errors include the exact map key as `dataKey`; this avoids ambiguity for keys containing punctuation. Emit diagnostics only where errors originate, including independent errors raised by dependent expressions. Do not emit duplicate diagnostics for missing failed dependencies; retain their originating references internally and in completion error blockers. `EvalError` has no `root` field. Conflict `root` is separate and unchanged.
   - **Relevance seeds:** all internal/output value targets (even unreferenced ones), every parameter's availability target, all other targets and bound-consistency checks of currently available parameters, item guards, evaluated item fields, and result arithmetic. Relevance is this seed set plus all dependencies reachable backward through the static graph, including all candidate-rule references. Default validation includes bound consistency as well as the bound nodes themselves. A false item guard skips its other fields, so those fields cannot originate evaluation errors. An errored item guard is relevant and blocks finishing.
   - **Which errors block `finish`:** every originating error on a relevant target. Errors on other targets remain listed but do not block. Thus an unused errored internal/output blocks, while a bound error on an unavailable parameter does not unless a relevant target depends on it. A dependent item in error uses the originating error as its error blocker rather than creating a duplicate propagated diagnostic. A static `errorDerived` flag is never itself an additional error diagnostic or blocker.
   - **Variable `status`:** `error` for an originating value-target error; `unknown` for a value target unable to calculate because it actually needs a failed dependency. Attribute errors retain static fallback behavior and do not by themselves change the parameter value's status (3.2).
7. **Setting any parameter at any time** is accepted if the id and input shape are valid, and then re-evaluated. Parameter constraint problems are returned as state, not exceptions. Exceptions include unknown ids and wrong values (wrong type, null, non-finite floats, duplicate ids or non-string elements in a multiple choice, an integer outside the safe range), invalid explicit constant-internal choices at start/derive, and session-level errors (finished session, missing model file, 5). Per-kind validation follows 3.1.
8. **Authoritative pipeline:** `evaluate` resolves variable and attribute nodes, checks constraints, evaluates conditional items and result arithmetic, collects all diagnostics, and then computes completion. Only a true/omitted item guard evaluates the item's remaining expressions; false guards omit it, and unknown/errored guards list its unresolved/error outcome without evaluating fields. Rules and item expressions share effective values and compiled dependency metadata. Neither `buildResult` nor the session layer independently reruns expressions or patches completion. Error relevance follows 4.6; optional item-data completeness follows 3.8.

## 5. Session
- `sessionId` is a generated id.
- Storage v1: one JSON file per session, `<dir>/<sessionId>.json`. Writes are **atomic**: the file is written to a temporary file in the same directory, flushed, then renamed over the target, so a crash never leaves a half-written session. A missing store directory is created on first save.
- Session file: `{sessionId, modelSource, logicHash, textHash, modelVersion, schemaVersion, engineVersion, inputs, inputDefinitions, data?, dataIdentity?, dataChanges, status, createdAt, updatedAt, finishedAt?, derivedFrom?, acceptedChanges, sourceChanges, snapshot?}`. `data`/`dataIdentity` are present only for models with tables (3.12).
  - `updatedAt` is set by every command that changes the file. `finishedAt` is set by `finish` and equals the snapshot timestamp. All times come from the injected clock (6.1).
  - `derivedFrom` is null for a session started with start, otherwise identifies the source session, target-selection mode and source's accepted logicHash under 3.11. It is the link of the audit trail described in 5.3 and is copied into the snapshot.
- **Durable model source:** `modelSource` is a tagged value, either `{kind: "path", path: string}` or `{kind: "embedded", model: string, translations: Record<string, string>}`. `model` and the translation values are YAML contents; translation keys are locales. Normal `start` stores a path resolved against the working directory as an **absolute** path. An unfinished path-backed session reloads that file and applies the checks of 5.1. If the file is gone or moved, loading fails with `model_not_found`. An unfinished embedded session evaluates its own persisted model and translation contents; it never reloads the original path or source session and remains usable if either is deleted. Engine-version checks still apply. Finished sessions use only their snapshots.
- **Explicit source changes:** ordinary commands that load an unfinished session may use `--model <path>` (library: `modelPath` option) to re-point a path-backed source or switch an embedded source to a path-backed source. Derive is the exception: its modelPath selects the target and never modifies the source (5.3, 6.2). There is no automatic source switching or fallback to a file. The new path is resolved to an absolute path, loaded and checked under 5.1 before the source change is saved. Every successful source change appends `{at, from: ModelReference, to: ModelReference}` to `sourceChanges`, even if model contents and hashes are identical; an unchanged source adds no entry. The references use the tagged shape above, including the contents of an embedded source, so this audit record is self-contained. New sessions start with `sourceChanges: []`. The snapshot includes this history. Content-change acceptance remains separately recorded in `acceptedChanges`.
- Storage sits behind a small `SessionStore` interface (load/save/delete) so other backends can be added later. `save` must be atomic as above.
- **No concurrency control in v1:** atomic writes prevent corrupt files, not lost updates. Two processes modifying the same session concurrently can overwrite each other's changes (last write wins). Callers serialize commands per session.
- Finished sessions are locked: `set`, `reset` and a second `finish` are rejected after `finish` (error `session_finished`, CLI exit code 5). They stay immutable as an audit record.

### 5.1 Versioning
- `schemaVersion`: integer, declared in the model file. It is the version of the YAML model format. The engine has a constant list of supported versions (e.g. `SUPPORTED_SCHEMA_VERSIONS = [1]`) next to one schema per version. The loader reads `schemaVersion` first and picks the matching schema.
- `modelVersion`: free-form label set by the model author. Informational only, the engine never interprets it.
- `engineVersion`: semver of the evaluator (including the pinned CEL library). Recorded in sessions and snapshots, not declared by models. A change that alters evaluation results is a major bump, guarded by golden tests. This includes bug fixes that change results. Operational consequence: after such an upgrade every unfinished session needs one command with `force` (or a `deriveSession`) before it can be used again. Operators plan engine-major upgrades accordingly, e.g. by finishing or deriving open sessions in bulk.
- `logicHash` is the real integrity check. It excludes the top-level keys `translations` and `defaultLocale` and the `source` field of every table. `textHash` covers those and the translation files, and is informational only.

Mismatch behavior when loading an unfinished session:
| Case | Behavior |
|---|---|
| Unsupported `schemaVersion` | Hard error, no override. Newer than known: "requires a newer confX". Older and dropped: "no longer supported". `validateModelFile` reports the same. |
| `logicHash` differs | Error, overridable with `force` (`--force` in the CLI) only if all stored inputs remain structurally compatible (below). The state is flagged `modelChanged` after acceptance. No migrations in v1. |
| `textHash` differs only | No error, no `force` needed. The observing command is flagged `textsChanged` (informational), uses current texts, and persists the new hash on success. Later commands clear that flag unless texts change again. |
| `engineVersion` major differs | Error, overridable with `force`. The state is flagged `engineChanged`. |
| `engineVersion` minor/patch differs | Warning only on the command that first observes the difference; persist the current version on success. No engineChanged flag or acceptedChanges entry for this alone. |
| Finished session | Served from the snapshot, no checks needed. |

**Structural compatibility gate:** accepting a changed model requires every stored input to remain structurally compatible with its accepted declaration. A missing variable is `unknown_variable`; a changed kind (including parameter to constant internal or vice versa), or an internal becoming calculated, is `kind_changed`; a changed declared `type` or effective `multiple` flag is `type_changed` (omitted `multiple` means false). `force` cannot override these incompatibilities. Reject with `incompatible_inputs`, listing affected ids and reasons, and direct callers to `deriveSession`, which reports incompatible copied inputs as dropped in a new session. Never silently discard or coerce stored inputs. Rejection leaves the entire persisted session unchanged, including inputs, hashes, source, timestamps and audit histories; an attempted source switch is not committed either.

For this comparison, persist `inputDefinitions: Record<Id, {kind: "parameter" | "internal"; type: "int" | "float" | "string" | "bool" | "choice"; multiple: boolean}>` alongside inputs. Each stored input has an entry describing its accepted declaration; entries are added/removed with inputs and refreshed only after successful model acceptance. Snapshot and derivation retain these definitions so compatibility does not require the previous model file. Changed parameter bounds, format or choice ids are not structural incompatibilities: retain those inputs and report ordinary conflicts. Additionally, a stored constant-internal choice override must still contain only declared ids: removed ids reject acceptance with `incompatible_inputs`, reason `invalid_choice`, even with force, leaving the session unchanged. This is a per-kind value-validity gate rather than a structural type change; internals cannot carry conflicts.

**`force` lifecycle:** `force` accepts the change **once**, subject to the structural compatibility gate above. The command that was run with it re-evaluates against the current model, then the session stores the current `logicHash`, `textHash`, `modelVersion` and `engineVersion` and appends an entry to `acceptedChanges`: `{at, from: {logicHash, modelVersion, engineVersion}, to: {...}}`. Later commands run without `force`, because stored and current values match again. Inputs are not touched: compatible parameter inputs that violate the new constraints show up as normal conflicts. A forced session can be finished if completion permits. Its snapshot carries `acceptedChanges`, so an audit shows accepted model/engine changes. Set `modelChanged` exactly when any accepted entry has different from/to logicHash; set `engineChanged` exactly when any accepted entry has different from/to engineVersion majors. These historical flags are independent and remain true once their respective change was accepted. Text-only and engine-minor/patch-only observations do not append acceptedChanges. Passing force when no acceptance is needed adds no entry.

**Observed metadata lifecycle:** every successful unfinished-session command, including reads, persists changed observed metadata (current textHash and minor/patch engineVersion, plus other successfully accepted metadata). Return textsChanged by comparing the pre-command stored textHash with the loaded current hash; report a minor/patch version warning when first observed. Subsequent commands see the updated baseline and do not repeat these transient notices unless another change occurs. Build the response's observed flags/notices before updating that baseline. No-change reads do not rewrite the session; metadata-only saves update updatedAt using the injected clock. Failed commands save nothing, including a failed source switch. A finish refusal does not finish the session and saves nothing, with one exception: data refreshed in that call (`refreshData`) is persisted with its `dataChanges` entry and changed observed metadata (3.12). Derivation observes its source without saving it (5.3). Finished-session reads use the snapshot only, never inspect current model/engine metadata and never write. Session notice envelopes and snapshot transient-flag handling are specified in 3.10.

Schema compatibility: every change to the model format bumps `schemaVersion`, including a new optional key and any change in the meaning of existing fields. The validator rejects unknown keys, so an older engine gives a clean error on a newer model instead of silently ignoring a key. Only changes outside the format (e.g. translation texts, engine internals) leave it unchanged.

### 5.2 Snapshot on `finish`
`finish` stores a self-contained snapshot: the final evaluated state and the final result (3.8), both in the **locale-free** form, the inputs and their `inputDefinitions`, the pinned table data with its `DataIdentity` and `dataChanges` (3.12), `acceptedChanges`, `sourceChanges`, `derivedFrom`, `logicHash`, `textHash`, `modelVersion`, `schemaVersion`, `engineVersion`, a timestamp, and the **full embedded model including all translation files**. Audits then work even if the model file changed or is gone, and the snapshot can be rendered in any declared locale later with `localize`.
- The snapshot is a record, never live state. Live state is always recomputed from the inputs.
- Numbers: `int` values are `bigint` internally and JSON cannot represent them. The serialization rule is in 3.4.

### 5.3 Deriving sessions
A finished session is never reopened. Two use cases are supported by creating a **new** session from its inputs:
1. **Variation** ("same thing, a little different"): extract the inputs and start a new session, which stays editable. This is no re-evaluation of the old session, only an input transfer.
2. **Re-evaluation** ("configured 3 weeks ago, buying now, prices may have changed"): evaluate the stored inputs against the **current** model (or optionally the embedded one) and compare with the snapshot.

Both use the same primitive: `deriveSession(sessionId, {modelPath?, useEmbeddedModel?, carryDefaults?, initialValues?, keepData?, force?})`.
- **Table data:** fresh from the target's `DataSource` by default, or copied from the source with `keepData` (3.12).
- **Source may be finished or unfinished.** A finished source has a snapshot. For an unfinished source there is no snapshot, so the diff baseline is a fresh evaluation of its stored inputs against its persisted `modelSource`, with the checks of 5.1 applied. `useEmbeddedModel` specifically selects a finished source's snapshot and is an error (`no_snapshot`) for an unfinished source.
- **Unavailable unfinished baseline:** if the source's stored inputs cannot be evaluated against its loaded model for any incompatible_inputs reason under 5.1 (unknown_variable, kind_changed, type_changed, or constant-internal invalid_choice), derivation may still proceed using the persisted input definitions and target-model drop/override rules. Return diff null and an explicit baselineUnavailable diagnostic identifying the incompatible inputs and reasons; do not fabricate a before-state or silently omit the explanation. This exception does not bypass missing/invalid model errors, unsupported schema versions, engine-version checks or other unrelated source/model checks. It does not modify or accept changes into the source session. A finished source always uses its snapshot baseline and returns a normal diff. A copied constant-internal value with removed choice ids is dropped under E1, unless superseded by a valid explicit override.
- **Target model source:** `useEmbeddedModel: true` copies the snapshot's model YAML and all translation YAML contents into the new session as its own `{kind: "embedded", ...}` source, not a reference to the source session. `modelPath` selects a new absolute path-backed source. Without either option, a path-backed source retains its path (for a finished source, the recorded path is loaded as the current model); an embedded source retains its self-contained embedded contents. The two selection options are mutually exclusive: supplying `modelPath` together with `useEmbeddedModel: true` is an argument error. A new session starts with an empty source-change history; derivation provenance is recorded in `derivedFrom`, not as a source switch.
- **Dropped vs kept.** An input is **dropped** (returned in `droppedInputs` with a reason, never silently) when it is structurally incompatible with the target model, using the same definitions as 5.1: `unknown_variable` (id no longer exists), `kind_changed` (kind changed, including parameter/constant-internal transitions, or an internal became calculated), `type_changed` (the declared `type`, or effective `multiple`, changed). Compare with the source's accepted `inputDefinitions`, not just the value's JavaScript shape. A compatible parameter input is **kept** and reported as a conflict when it violates constraints: `out_of_range`, `pattern_mismatch`, `unavailable`, and `invalid_choice` for a choice id that was removed from `choices` (per id for multiple choice, 3.1). The test is "can the value be stored for this variable", not "is the value valid". A copied constant-internal choice value containing removed ids is instead dropped with reason `invalid_choice`, because internals cannot carry conflicts; drop the entire input, not just individual list elements. Invalid explicit internal overrides are rejected rather than dropped (3.1).
- **Defaults.** Defaults are not stored (3.5), so by default a derived session follows the **target** model's defaults, and a changed default shows up in the diff as a changed value with `source: default` (the diff compares effective values, not only inputs). With `carryDefaults: true` the effective default values of the original snapshot are written into the new session as explicit inputs, so a re-evaluation compares like for like. Carried defaults that no longer fit are dropped or kept by the same rules as other inputs. `carryDefaults` needs a snapshot (error `no_snapshot` otherwise). CLI flag: `--carry-defaults`.
- **Explicit initial values:** `initialValues` is an optional `Record<Id, Value>` of replacement inputs for the target model. Precedence, highest first: explicit initial values, compatible copied source inputs, carried parameter defaults (when requested), target model defaults. Validate explicit entries as new target-model inputs under the same rules as `startSession`: parameters and constant internals are allowed; unknown ids, wrong values, outputs and calculated internals are rejected rather than dropped. Parameter constraint violations remain ordinary conflicts. An explicit replacement supersedes the corresponding source input or carried default before copied-input compatibility checks; the superseded value is not reported in `droppedInputs`. Other incompatible copied inputs still follow the drop rules above. Persist input definitions from the target model for all retained and explicit inputs. Invalid explicit entries fail derivation without creating a new session.
- **No override reset marker:** omitting a key from `initialValues` inherits the ordinary copied/default behavior; it does not reset that variable. `null` is not a reset instruction or a valid explicit input. After derivation, `resetParameter` can remove a copied parameter input and return it to the target default (or unset). There is no special derive-time removal syntax in v1, and constant internals remain fixed after session creation.
- The new session records `derivedFrom` (5).
- The new session is unfinished. Its `finish` creates a new snapshot, and the original stays untouched. This gives an audit trail: original configuration, then re-priced order.
- The result includes a `diff` against the original snapshot or unfinished baseline (changed values, new conflicts, dropped inputs, and changed items, articles and total), except for the explicit unavailable-baseline case above, which returns null plus a diagnostic. The diff is also available as pure helpers `diffState(a, b)` and `diffResult(a, b)`.
- A mismatch between the original and the target model does not need force, because the new session is evaluated freshly. Loading an unfinished source for baseline evaluation can require force under 5.1; this is permission to evaluate that baseline, not acceptance into or modification of the source. Incompatible stored inputs, including constant-internal invalid_choice, use the explicit unavailable-baseline exception instead of forcing an invalid evaluation; unrelated checks still apply. The derive result (not the new session's own state, which starts with an empty acceptedChanges) carries modelChanged and engineChanged flags for information.

## 6. Architecture and API
### 6.1 Layers
1. **Core (pure, no I/O):** `loadModel(yamlText, translations)`, `validateModel(model)`, `evaluate(model, inputs, data) -> Evaluation` (public `state` plus already evaluated item outcomes and checked totals, 3.9), `buildResult(model, evaluation, status) -> result` (formatting only; `status` is `final` or `provisional`, 3.8, 3.9), `localize(model, stateOrResult, locale) -> localized` (3.7), `diffState(a, b)`, `diffResult(a, b)`, `hashModel(yamlText, translations) -> {logicHash, textHash}`, `validateData(model, data) -> DataIssue[]`, `hashData(data) -> dataHash` (3.12), the locale-free question helpers `buildSectionTree(model) -> SectionState[]` and `nextOpenParameter(model, evaluation, {includeOptional}) -> VariableState | null` (3.6, 6.2), and the `engineVersion` constant. It never touches files, the clock or random ids. `evaluate` and `buildResult` are pure functions of their inputs and locale-free, which is what golden tests and WASM/browser embedding need.
2. **Session layer:** the commands in 6.2. It uses a `SessionStore` (load/save/delete), a `ModelSource` (resolves a persisted `ModelReference`: a path-backed source reads model and translation files, an embedded source supplies its stored YAML contents without file I/O) and a `DataSource` (loads table rows, 3.12; the default reads the tables' `source` files, applications inject their own). It generates session ids and timestamps, audits explicit source switches, and performs the `logicHash` / `engineVersion` checks from 5.1.
3. **CLI:** argument parsing, JSON on stdout, exit codes. A thin wrapper over the session layer.

Rules: all non-determinism (ids, `createdAt`, snapshot time) is injected or generated in the session layer, never in the core. The boundary is enforced by a lint rule that forbids Node imports (`fs`, `path`, `crypto`, ...) in the core folder. `hashModel` therefore uses the pure-JS SHA-256 from `@noble/hashes` (§8). Packaging for v1: Node.js >=24, one ESM-only npm package, TypeScript NodeNext module/moduleResolution settings, explicit exports and declaration files for `confx/core` and `confx` (sessions), plus the CLI bin. No CommonJS entry point in v1. The core entry point remains free of Node imports and usable by browser bundlers.

### 6.2 Session API (library functions, mirrored 1:1 as CLI commands)
All return values below are the data member of SessionResponse<T>, accompanied by command-level notices (3.10). The core API is not wrapped.

```ts
type DataFiles = Record<Id, string>;   // table id -> data file path, per-call override, not persisted (3.12)
interface SessionOptions { modelPath?: string; force?: boolean; refreshData?: boolean; dataFiles?: DataFiles }   // refreshData/dataFiles: 3.12, dataFiles only together with refreshData
interface StartOptions { initialValues?: Record<Id, Value>; dataFiles?: DataFiles }
interface ValidateOptions { dataFiles?: DataFiles }
interface ReadOptions extends SessionOptions { locale?: string }
interface NextOptions extends SessionOptions { includeOptional?: boolean }
interface DeriveOptions {
  modelPath?: string; useEmbeddedModel?: boolean; carryDefaults?: boolean;
  initialValues?: Record<Id, Value>; keepData?: boolean; force?: boolean;
  dataFiles?: DataFiles;   // not together with keepData
}
```

Supplying `dataFiles` without `refreshData` on an existing-session command, or together with `keepData` on derive, is an `invalid_argument`. Options default to an empty object, false for boolean options, and locale-free output if locale is omitted. For ordinary existing-session commands modelPath explicitly changes an unfinished source (5); for derive it selects only the target and never re-points the source. Finished reads always use snapshots; reject modelPath/force/refreshData on finished reads as invalid_argument rather than pretending to change the snapshot. Set/reset/finish on a finished session always reject with session_finished. Supplying locale as a positional string is not part of this API.

| Command | Behaviour |
|---|---|
| `startSession(modelPath, options?: StartOptions)` | Allowed initial values: parameters and constant internals. Outputs and calculated internals are rejected. Loads (using `dataFiles` overrides), validates and pins table data (3.12). Returns sessionId and state. |
| `setParameter(sessionId, id, value, options?: SessionOptions)` | Sets the value, re-evaluates, returns the new state. |
| `resetParameter(sessionId, id, options?: SessionOptions)` | Removes the input value and its input definition; returns the new state. |
| `getState(sessionId, options?: ReadOptions)` | Returns the `SessionState` (3.9): variables, targets, sections, conflicts, errors, warnings, `completion` (`canFinish` plus blockers), session `status`, and the `modelChanged` / `engineChanged` / `textsChanged` flags. Localized if options.locale is given. |
| `getOrderLines(sessionId, options?: ReadOptions)` | Returns the result format (3.8): items with article, quantity, unit price, data, and the total. Does not change inputs; allowed on unfinished sessions (`status: provisional`), with observed-metadata saves under 5.1. Finished sessions are served from the snapshot and localized on request. |
| `getNextOpenParameter(sessionId, options?: NextOptions)` | An **open** parameter is available, has no value (`status: unset`, a usable default counts as a value, 3.5) and is mandatory, or optional if includeOptional is true (default false). A parameter that has a value is never open, even if it is in conflict: conflicts are reported in the state, not through this call. A parameter whose default was rejected (3.5) is unset and therefore open. Order as in 3.6. Returns the full VariableState (including id, multiple, effective range/choices), or null if none are open. |
| `finishSession(sessionId, options?: SessionOptions)` | Succeeds only when the authoritative evaluation's `completion.canFinish` is true: all mandatory available parameters are set, there are no conflicts or relevant errors, all listed items are `ok`, and result arithmetic succeeded. False-guard items are omitted and do not block finishing. Returns finished true with state/result on success, otherwise finished false with state and its exact blockers (3.10). |
| `deriveSession(sessionId, options?: DeriveOptions)` | Creates a new unfinished session from the inputs of an existing one (finished or unfinished), against the current or embedded model. Explicit initialValues replace copied inputs and are validated as new target-model inputs (5.3). Returns the new sessionId, state, droppedInputs and a diff against the snapshot/fresh baseline; if any incompatible_inputs reason prevents an unfinished baseline, including constant-internal invalid_choice, returns diff null plus baselineUnavailable identifying those inputs (5.3). Never modifies the source session. |
| `validateModelFile(modelPath, options?: ValidateOptions)` | Session-layer wrapper (CLI command `validate`): reads via ModelSource, collecting parse/schema diagnostics as well as semantic checks from core validateModel. Table data is checked only for tables listed in `dataFiles` (or all tables if a `DataSource` was injected into the session layer); invalid data throws `data_invalid` with its issues (3.11) and is never reported as a model diagnostic. Returns ValidationData with valid and diagnostics (3.10–3.11), not a bare list. |

Constant internals can be overridden only at `start` or `derive`. Calculated internals cannot be overridden. `set` and `reset` apply to parameters only.

### 6.3 CLI
The CLI mirrors the session API 1:1 (`start`, `set`, `reset`, `state`, `lines`, `next`, `finish`, `derive`, `validate`) and contains no logic beyond argument parsing and output.
- **Session and store:** `--session <id>` selects the session. `--store <dir>` selects the store directory. Precedence: `--store`, then the `CONFX_STORE` environment variable, then `./.confx/`.
- **Model location:** `start` takes the model path and stores an absolute path-backed `modelSource`. `derive` accepts `--model <path>` to evaluate against a different model, `--embedded` to copy the snapshot model and translations into a self-contained embedded source, and `--carry-defaults` (5.3). `--model` and `--embedded` are mutually exclusive. Any command that loads an unfinished session accepts `--model <path>` to re-point a moved model file or explicitly switch an embedded source to a file-backed source; successful source changes are audited (5).
- **`--force`:** applies to commands that load unfinished sessions (see 5.1). Normally it accepts the model or engine change once and records it in the session (acceptedChanges), so later commands need no force. For derive, target-model differences never need force, but unfinished-source baseline evaluation may need it; in that case force permits baseline evaluation only and never modifies the source. Any incompatible_inputs reason uses diff null plus baselineUnavailable instead, including constant-internal invalid_choice; unrelated source/model checks remain in force (5.3).
- **Values:** `set <id> <value>` is parsed by the variable's declared type from the model: `int`, `float`, `bool`, `string`, `choice`, and multiple choices as a comma-separated list. A parse failure is a usage error (exit code 1).
- **Table data (3.12):** `start`, `derive`, `validate` and `--refresh-data` runs accept `--data <table>=<file>` (repeatable, API option `dataFiles`) to read a table from a file instead of its declared `source`. Overrides are not stored in the session. Without a declared source or override, loading fails with `data_source_error`. `--refresh-data` reloads pinned data on any command that loads an unfinished session; `derive --keep-data` copies the source's data instead of loading fresh data.
- **Initial values:** `start` and `derive` accept `--initial-values '<JSON object>'`, passed as the API's `initialValues` map. JSON preserves strings, booleans, numbers and multiple-choice arrays without comma-list escaping; e.g. `--initial-values '{"width":120,"pricePerCm":1.8}'`. Malformed JSON, a non-object top-level value, or an invalid explicit input is a usage/wrong-value error (exit code 1). JSON `null` values are invalid, not reset markers. Precedence and copied-input replacement for derivation follow 5.3.
- **Output:** JSON only, always on stdout. Successful command responses use `{data, notices}` (3.10), including finish refusal with exit 4 and model validation diagnostics with exit 2. Exceptions use `{"error": {"code": ..., "message": ..., "details"?: ...}}`, omitting details when absent and never including stack traces. Human-readable diagnostics go to stderr. No pretty-print mode (use `jq`).
- **Conflicts are state, not errors.** A state with conflicts exits with 0.
- **Exit codes:**
| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error or unexpected error (including unknown variable ids and wrong values: wrong type, duplicate multiple-choice ids, integers outside the safe range) |
| 2 | Model invalid, unsupported `schemaVersion`, or invalid table data (`data_invalid`). For `validate`: at least one **error** (warnings alone exit 0, and are listed in the JSON output) |
| 3 | Session, model or data file not found or data source failure (`data_source_error`); `logicHash` / engine-major mismatch (needs `--force`); or `incompatible_inputs` after a model change (cannot be overridden with `--force`; derive a new session instead) |
| 4 | `finish` refused (open mandatory parameters, conflicts, errors or unresolved listed items) |
| 5 | Session is finished and locked (`set`, `reset`, `finish` rejected) |

## 7. Model Validation Checks
- YAML parsing: exactly one YAML 1.2 document using the core schema. Reject duplicate mapping keys, non-string mapping keys, anchors, aliases, merge keys and custom tags. Reject non-finite numeric scalars and integer scalars outside the safe range. Preserve scalar types without schema-driven coercion: a quoted numeric string remains a string. Apply the same parsing policy to model and translation contents; hashing uses the resulting parsed model before schema-default injection (8).
- YAML schema (required fields, types, unknown keys)
- Unique ids, valid id syntax, no reserved identifiers (3.3)
- Choice ids use the identifier pattern and are unique within their variable. Explicit rule ids use the identifier pattern and are globally unique among rules; generated rule ids use 1-based per-target positions and cannot collide with explicit ids (3.9).
- Type-specific field rules (e.g. no `format` on int, `min <= max`, valid regex)
- Output variables must have at least one assigning rule.
- Within a target, no rule after an unguarded rule (error). `when` must be a YAML string containing a CEL expression whose checked result type is bool, not a YAML boolean. Warning if an output, or an internal without `default`, has only guarded rules (an internal with a `default` is a valid pattern, see 3.2).
- Parameters must not be assigned (only constrained).
- Rule targets and referenced ids exist. Attribute targets are valid for the kind and type (matrix in 3.1). Fields outside the per-kind matrix are errors. Top-level keys follow 3.0.
- Expressions parse and type-check statically where possible. `set.<name>` accesses refer to existing variable ids (3.3).
- No dependency cycles
- Translation completeness: warning for missing translation ids per locale, warning for unused ids, error for a missing or unparsable file listed in `translations` (details in 3.7)
- Sections: unique ids (shared namespace with variables), existing `parent` / `section` references, no parent cycles (3.6)
- Unused internals: warning (variables used only by items count as used)
- Tables (3.12, code `invalid_table` unless noted): unique ids in the shared namespace, valid `key`/column ids, column ids unique and different from `key`, valid column types, at least one column. `choicesFrom` only on choice parameters, not together with `choices`, referencing an existing table; its `when` type-checks to bool with `row` bound to the table's row type; `textColumn` is a string column. No `<id>.choices.<c>.available` rules on `choicesFrom` parameters. Table ids are not rule targets. Table accesses in expressions type-check against the declared columns. A table referenced by no expression and no `choicesFrom` is a warning (`unused_table`). A declared `source` file is not read by `validate`; only data given via `--data` (`dataFiles`) or an injected `DataSource` is checked, otherwise data checks are runtime (`data_invalid`).
- Items (3.8): unique ids (shared namespace), required article/price and optional quantity/when are YAML strings containing CEL expressions with checked result types string/float/int/bool respectively. Data values type-check (a textKey expression must be string; its string literals are checked against translation files as a best effort, while dynamically built keys use runtime localization fallback). `pricing.currency` is present if items exist; `pricing.pricePrecision` is an integer from 0 to 6 inclusive. Variable precision is an integer from 0 to 12 inclusive. A missing required item price is a schema error.
- Default values match the declared type and constraints (for multiple choice: non-empty, valid ids, no duplicates; for constant internals with `precision`: at most that many decimals, 3.1). Constant internals must declare a default. Defaults must be finite and integer defaults must be safe integers. `format` is a valid regex. Choice id literals in comparisons exist in the variable's `choices` (3.3).

## 8. Tech Decisions
- **Language/runtime:** TypeScript, Node.js >=24 for sessions/CLI, ESM-only npm package with NodeNext module/resolution settings and explicit exports/declarations for confx/core and confx plus the CLI bin (6.1). Core stays Node-import-free for browser bundlers. YAML via `yaml`. Expression language: CEL via `@marcbachmann/cel-js` (decided, see 3.3). Hashing: SHA-256 via `@noble/hashes` (pure JS, synchronous, pinned), so hashModel stays in the pure core without Node crypto or async WebCrypto.
- **Package manager:** pnpm, pinned via the `packageManager` field in `package.json` (Corepack). The lockfile `pnpm-lock.yaml` is committed; CI installs with `pnpm install --frozen-lockfile`. Dependencies are pinned to exact versions (`save-exact=true` in `.npmrc`). The published artifact is still a regular npm package. Local fixes to dependencies use `pnpm patch` (`patches/`), each documented and covered by tests; currently the CEL library (`cel-verification.md`).
- **Schema validation:** Zod runtime schemas are the source of truth for both model and public output contracts, with TypeScript types inferred from them. Use one model schema per schemaVersion; the documented output shapes in 3.9 define what the output schemas must implement. Refinements cover cross-field rules. Validation runs in two stages: (1) structural checks in the schema, (2) semantic checks in plain code (unique ids, references, CEL type-check, cycles, rule order, section 7) that collect all errors instead of stopping at the first. A JSON Schema export for editor support is a possible later addition.
- **Interfaces:** the core library has no I/O (see 6.1). The session layer sits on top, and the CLI is a thin wrapper. Delivery is the library plus the CLI, with no HTTP API.
- **Testing:** golden-file tests are the main test type. Core cases for models with tables supply table data as `data.json` next to `model.yaml`.
  - **Core suite:** one folder per case in tests/golden/core/<case>/ with model.yaml, supplied translation contents where applicable, steps.json describing pure-core operations and expected.json. The runner supplies fixture contents as strings; core APIs require no filesystem, clock, random ids or session APIs. Cover parsing, hashes, validation, evaluation, results, localization and pure diffs as their packages land. WP 3–4 can test internal stages, but do not expose incomplete stages as authoritative public evaluate outputs.
  - **Session suite:** one folder per case in tests/golden/sessions/<case>/ with model/translation fixtures, steps.json and expected.json. Steps use ordered library commands start/set/reset/finish/derive/state/lines/next/validate, including options from 6.2. Expected outputs contain full data/notices envelopes or typed failures, with injected fake clock/id generator and isolated stores/model sources. Add these cases when session infrastructure arrives in WP 8–9, not as a prerequisite for the initial harness.
  - Neither golden suite invokes the CLI. A small separate CLI suite checks argument parsing, JSON envelopes/errors and exit codes.
  - `expected.json` is generated with `UPDATE_GOLDEN=1` and reviewed in the diff, never edited by hand.
  - Numbers are compared exactly (see 3.4). An engine change that alters results shows up as golden diffs.
  - Every decided rule has at least one case in the appropriate suite: unknown short-circuit, first-match guards, default fallback, taint with causedBy, parameter defaults, deriveSession against a changed model, and fixed hashModel values for known inputs. Every resolved review decision in section 10 (A1–T2) also has at least one golden case covering its rule; these are planned tests, not claims that tests already exist.
  - **Canonical hash encoding:** hash UTF-8 bytes of canonical JSON: recursively sort object keys by lexicographic UTF-16 code-unit order, preserve array order, serialize strings/numbers/booleans/null with JSON.stringify semantics, use no whitespace, and perform no Unicode normalization. The logicHash document is the parsed model document before schema-default injection with only top-level translations/defaultLocale and each `tables[].source` field removed; comments/formatting do not matter, while omitted versus explicitly written defaults differ. The textHash document is `{defaultLocale: <locale or null>, translations: [{locale, content}, ...]}`, with entries sorted by locale using the same code-unit order. Content strings preserve translation file contents exactly, including whitespace/newlines; paths are excluded. This JSON framing unambiguously distinguishes file/locale boundaries. Both outputs are lowercase hexadecimal SHA-256. Golden cases cover exact known hashes, text-only changes leaving logicHash unchanged, every non-text key change affecting logicHash, identical-content path changes leaving both hashes unchanged, table `source` path changes leaving logicHash unchanged, and declaration defaults versus omission.

## 9. Proposed Work Breakdown
Golden tests (section 8) are the main test type, so the harness comes first and **every package adds its own golden cases as it lands**. Separate pure-core cases from later session-command cases; there is no final catch-all test package. Public output schemas implement 3.9–3.11 from the start, but incomplete internal stages do not claim to implement the final public evaluator.
0. **Project setup, contracts and golden harness:** Node.js >=24, ESM-only packaging, TypeScript NodeNext settings, explicit exports/declarations/bin (6.1), lint rule for the core/session boundary, runtime/output schemas for the agreed public contracts (3.9–3.11), core golden harness with UPDATE_GOLDEN=1, and the desk example (11) as a fixture. Provide harness extension points for later session cases; do not require session APIs, fake-clock behavior or persistence to run initial core cases.
1. **Model schema and loader (core):** top-level keys (3.0), restricted YAML parsing, one model schema per schemaVersion, typed model objects (variables, sections, pricing, items, tables), parsing supplied translation contents without file I/O, and hashModel with fixed hash values in core golden tests. File loading belongs to ModelSource in WP 8.
2. **Expression engine:** CEL environment, id binding and type conversion, `unknown` via missing-variable errors, numeric helper signatures/domains (3.4), and the `set` presence map. Before evaluator implementation, verify pinned-library signed-64-bit literals, conversions, arithmetic overflow and helper boundaries; adapt or explicitly reject unsupported behavior. (Prior spikes confirmed short-circuit, error detection, `check()` and `has(set.x)` on `@marcbachmann/cel-js` 8.0.0. Signed-64-bit behavior and typed table rows were verified in WP 2; both gates pass, see `cel-verification.md`.) **Tables spike, also in WP 2:** verify typed object values (`Row`) in `map<string, Row>` with static type checking of `products[product].basePrice`, a distinguishable missing-key error, `in` and the `exists` macro on maps, binding `row` for a per-row filter, and the complete list of globally bound names for the reserved identifiers (3.3). If typed rows are unsupported, revise 3.12 before WP 3.
3. **Dependency graph and variable evaluation stages (core):** expanded target/effective-value DAG (4.1), model-static cycle detection, topological evaluation helpers, first-match selection/outcome table, effective constraints/defaults and precision rounding. Add section-tree construction/ordering and locale-free next-open-parameter selection. Test internal stages and graph counterexamples now; do not publish authoritative evaluate/completion before WP 6 integrates items.
4. **Constraint checking, conflicts, taint and errors (core):** per-type validation, parameter and per-choice availability, conflict shape with `causedBy`, static taint and `errorDerived`, rejected defaults and `warnings`. Supplies variable diagnostics and mandatory-input checks; authoritative `completion` / `canFinish` is finalized with item outcomes in package 6.
5. **i18n (core):** translation id derivation and localize with locale resolution/fallback reporting (3.7). Question ordering/traversal belongs to the locale-free helpers in WP 3, not localization.
6. **Positions, result and authoritative completion (core):** integrate item-expression evaluation into `evaluate` using the shared effective context, `origin` from compiled dependency metadata, rounding and checked totals, conditional inclusion and position status (3.8). Finalize `completion` / `canFinish` only after all item outcomes and result arithmetic are known. `buildResult` formats these outcomes without reevaluation. `diffResult` comes with 9.
7. **Model validator (core):** the checks in section 7. Can start once 1 and 2 are done and grows with 3 to 6.
7a. **Tables (core):** table declarations in the schema, `validateData`/`hashData`, typed `map<string, Row>` bindings and missing-key-as-unknown in the CEL environment (relying on the tables spike from WP 2), `choicesFrom` with the row-filter target in the graph, `no_available_choice` warning, the panel example (11.2) as a fixture. Can start after 3 and grows with 4 and 6. Session parts (`DataSource`, pinning, refresh, `dataChanges`, snapshot, derive `keepData`) belong to WP 8–9, CLI `--data`/`--refresh-data`/`--keep-data` to WP 10.
8. **Session layer foundations:** SessionStore interface/atomic JSON implementation, durable path/embedded ModelReference resolution through ModelSource (including model/translation file loading), input-definition metadata, source-switch audit history, versioning/mismatch checks and observed notices (5.1), acceptedChanges and snapshot persistence (5.2). Extend the golden harness with isolated stores/model sources and injected clock/ids; begin session foundation cases here.
9. **Session API and diffs:** start/set/reset/state/lines/next/finish and deriveSession with the normative envelopes/options/errors (3.10–3.11, 6.2); pure diffState/diffResult helpers in core with core golden cases, and command-sequence session golden cases covering snapshots, derivation, dropped inputs, notices and refusal/acceptance behavior.
10. **CLI wrapper:** commands mapped to the API, JSON output, exit codes (6.3), plus the small set of CLI tests.
11. **Docs:** model reference, including the matrices of 3.1.
12. **Evaluation items (not v1):** `decimal` type spike (3.4), multi-rule combining, dynamic taint (4.4), content-addressed storage of pinned table data (keyed by `dataHash`) instead of a copy per session file, session locking.

**Milestone M1 (first end-to-end path):** WP 0–4 and 6 plus the validator parts of WP 7 they need, for models **without tables**, then WP 8 and the start/set/reset/state/lines/next/finish commands of WP 9 and their CLI commands from WP 10. Golden cases for M1 cover the desk example (11.1). Deferred to later milestones, each with its own golden cases: tables (WP 7a), derivation and diffs (rest of WP 9), source switching and acceptance history details beyond what WP 8 needs for `force`, and localization (WP 5) if not needed by the first consumer. The spec for deferred features stays normative; M1 only fixes the order.

Suggested order: 0 → 1 → 2 → 3 → 4, then 5/6/7/7a, then 8 → 9 → 10 → 11. WP 2's signed-64-bit verification and tables spike are gates before WP 3 evaluator implementation. WP 7 can start after 1/2 and grows alongside 3–6. Localization (5) and item integration (6) are independent; full authoritative evaluate/completion is available only after 6. Validator readiness tracks the features being validated, not an assumption that all of 7 can finish before them. Storage/model-source foundations may start earlier independently, but full session behavior/tests require the complete evaluator and validator. The core/session boundary is enforced by the lint rule from WP 0.

## 10. Decisions and Open Questions
Decided:
- TypeScript, library plus CLI (no HTTP).
- Internals are either constant (overridable at start/derive only) or calculated by rules (not overridable). A calculated internal's default applies only when no rule matches or a guard makes selection undecidable, never for a selected expression's unknown/error or a guard error (see 3.2, 3.5).
- Parameter `default` is a non-stored starting suggestion (see 3.5). `choices` is not a rule target. No `setInternal` in v1.
- Expression language: CEL (`@marcbachmann/cel-js`), ternary syntax, `unknown` via missing-variable errors (see 3.3).
- `bool` is a variable type.
- Numeric semantics: doubles for `float` with `precision` rounding, exact `int`, no decimal type in v1 (see 3.4).
- State output: one normative schema in 3.9. Values live in `variables`. `targets` lists the rule ids per target, marks the selected rule in `active` (including unknown/errored selected expressions) and a `status`. `active: null` means no rule was selected; it does not by itself distinguish no match, an unknown guard or a guard error.
- Texts live in one translation file per locale. Translation ids are derived from variable, choice, section and position ids, with optional `nameKey` / `descriptionKey` overrides (see 3.7).
- Sections group variables as a tree and affect presentation and question order only (see 3.6).
- Rules can constrain individual choices (`<param>.choices.<choiceId>.available`) as well as `min/max/available`.
- Result format for external systems: separate from the state, formatted from the authoritative evaluation by `buildResult`, exposed as `getOrderLines` (3.8). Items are declared in the model (`items:`), independent of sections, with article, quantity, unit price and enrichment `data`. False guards omit optional items without evaluating their fields. Finishing requires all listed items to be `ok` and successful result arithmetic. The result total (sum of the rounded position totals) is the single source of truth for the price. One currency per model (declared in `pricing`), no tax in v1. `getOrderLines` works on unfinished sessions (`status: provisional`). Repeating items are reserved for later.
- `unknown` for availability is treated as available (3.3). Rule-level `when:` guards with first-match semantics (3.2). A selected choice that becomes unavailable is kept as a conflict of kind `unavailable` (4). CLI session handling, output and exit codes (6.3).

Review decisions applied:
- **A1–A2:** raw inputs and effective values are separate. All expressions observe effective values. The model-static dependency graph includes availability and default-validation dependencies; cycles are rejected without iteration (3.5, 4.1–3).
- **B1–B3:** one pure evaluation pipeline evaluates variables, constraints, conditional items and checked result arithmetic before computing completion. `buildResult` only formats evaluated outcomes. Rules and items share effective values and compiled dependency metadata. Finishing requires all listed items to be `ok`; false-guard items are omitted and do not block finishing (3.8–3.9, 4.8, 6.1–2).
- **C1:** sessions persist a tagged path-backed or self-contained embedded model source. Embedded derivation copies model and translation contents and has no lifetime dependency on the original file or session. Explicit switches to a path are audited in `sourceChanges`, including switches with identical model contents; there is no automatic source switching. `modelPath` and `useEmbeddedModel: true` are mutually exclusive (5, 5.2–3, 6.1, 6.3).
- **C2:** `force` cannot accept structurally incompatible stored inputs. Missing variables, kind changes (including parameter/constant-internal transitions), calculated-internal conversions, and type/multiplicity changes reject with `incompatible_inputs` and per-input reasons, leaving the session unchanged. Persist accepted input definitions to detect these changes without the old model file. Derivation drops incompatible copied inputs explicitly; compatible parameter constraint violations remain conflicts (5.1–3).
- **C3:** derivation accepts an `initialValues` map, validated as new target-model inputs. Precedence is explicit values over copied source inputs over carried parameter defaults over target defaults. Explicit replacements supersede copied values without a dropped-input diagnostic. `start` and `derive` expose `--initial-values '<JSON object>'`; there is no derive-time reset marker, and `null` is invalid (5.3, 6.2–3).
- **D1:** the normative outcome table distinguishes no match, unknown/error guards and successful/unknown/errored selected expressions. Unknown/error guards stop selection. Internal defaults only cover no match or unknown selection. `active` preserves the selected rule id even when its expression is unknown/errored; sources distinguish internal fallback (`default`) from selected expressions (`rule`) (3.2, 3.9).
- **D2:** conflicting variables are themselves tainted; only available conflicting values seed downstream taint. Propagation is target-level and static across all candidate rules/branches. Public variable flags aggregate value/attribute flags without creating extra dependency edges. `errorDerived` likewise aggregates target-level dependency flags and does not arise solely from a target's own error. Item `origin` remains fully static, including hidden/unused inputs (3.8–3.9, 4.4–6).
- **D3:** conflict `causedBy` excludes self references and unavailable conflicting input seeds, deduplicates ids, and uses variable declaration order. It reports static potential influence, not guaranteed causal repair. `root` means exactly an empty `causedBy`; cyclic explanations and nonempty conflict lists with no roots are valid. No SCC/group fields in v1 (4.4).
- **D4:** error relevance is an explicit seed set plus static backward dependency reachability. Unused internal/output errors and item-guard errors block; unrelated bound errors on unavailable parameters do not. Keep actual missing-error causes separate from static `errorDerived`: dependent values become unknown, dependent items become error only when a failed value was actually needed, and successful short-circuits remain successful. Emit originating errors only, remove `EvalError.root`, and refer dependent blockers to the originating error (3.9, 4.6).
- **D5:** item data is optional enrichment: ordinary unknown values serialize as null without invalidating item status or totals. Data-expression errors and actually needed failed dependencies make the item error and block finish. Missing translations only trigger localization fallback. Item-expression diagnostics identify field and exact data key. Unknown/errored guards skip remaining fields; for included items status precedence is error over incomplete over ok. No per-data-entry required flag in v1 (3.8–3.9, 4.6, 4.8).
- **E1:** constant internals require valid defaults; calculated internals may omit them. Inputs reject null, non-finite floats, unsafe integers and malformed multiple-choice arrays. Parameter unknown choices remain conflicts; explicit constant-internal unknown choices are rejected. Constant-internal multiple-choice defaults/overrides must be nonempty. Removed constant-internal choice ids reject force acceptance and cause copied derive inputs to be dropped as invalid_choice (3.1, 4.7, 5.1–3, 7).
- **E2:** inconsistent effective bounds emit one constraint-check evaluation error at the parameter with field bounds, keep bounds/user input visible, and do not also blame user input with out_of_range. Defaults against impossible ranges are rejected as out_of_range with null rule id. Error relevance follows D4. Consistent ranges emit at most one out_of_range conflict per parameter with the violated bound's provenance (3.9, 4.3, 4.6).
- **E3:** precision is bounded (variables/round 0..12, prices 0..6). Round unit prices first, multiply quantities and sum totals exactly in bigint minor units, and check safe-range plus exact decimal round-trip before JSON export. Quantities/int data share integer serialization limits. Numeric helper overloads/domains are fixed, and pinned-library signed-64-bit behavior must be verified before evaluator implementation (3.1, 3.4, 3.8–3.9, 7, 9).
- **F1:** logicHash covers non-text model content before schema defaults, including informational fields and translation-key overrides. Canonical UTF-8 JSON defines logic/text hash framing exactly. Model/engine-major acceptance flags are independent historical flags; text changes and minor/patch warnings are observed once per changed baseline. Successful unfinished reads persist changed metadata, no-change reads do not write, and failures/finished reads never update metadata (3.7, 5.1, 8).
- **F2:** remove unreachable no-price warnings, scope model id to session state, correct the unused-translation example, require YAML-string/CEL-bool guards, and make Zod schemas the implementation source of truth. Derive target differences need no force, but unfinished baseline checks may. When structural incompatibility prevents that baseline, allow input-transfer derivation with diff null and an explicit baselineUnavailable diagnostic, leaving the source unchanged (3.0, 3.7–3.9, 5.3, 6, 7–8).
- **F3 (part 1):** choice ids and explicit rule ids use the identifier pattern; choice ids are unique per variable, explicit rule ids globally among rules. Generated ids use 1-based target positions and cannot collide with explicit ids. YAML parsing is single-document YAML 1.2 core with no duplicate/non-string keys, anchors/aliases/merges/custom tags, non-finite numbers or unsafe integer scalars; no type coercion. Regex formats use strict end-of-input matching. Variable state exposes multiple as a boolean (3.1, 3.9, 7).
- **F3 (part 2):** session commands return data/notices envelopes, with structured start/derive/finish/validation payloads and full VariableState for next. Finish refusal is a normal response with exit 4. Typed ConfxError codes map to sanitized CLI error JSON. Models without items return an empty result with total 0 and currency null unless `pricing` declares a currency; declared items still require `pricing`. Transient notices are not replayed from snapshots (3.9–3.10, 5.1, 6).
- **F3 (part 3):** blockers use exact response-local conflict/error indexes and originating-error deduplication. Audit/drop/baseline records, timestamps, entity-level diffs, validation diagnostics/codes and code-specific exception details are defined normatively. Diffs ignore session/localization/lifecycle metadata and expose changed entities plus diagnostic/order/total changes. Common command/read options are explicit; derive modelPath selects only the target (3.9–3.11, 6.2).
- **F4:** separate early pure-core goldens from later session-command cases; core parses supplied translations while ModelSource loads files. Locale-free question traversal belongs to WP 3, localization to WP 5, and authoritative evaluation/completion to WP 6. Freeze Node.js >=24, ESM-only/NodeNext packaging and explicit core/session exports/declarations plus CLI bin (4, 6.1, 8–9).
- **X1:** the unavailable unfinished-baseline exception covers every incompatible_inputs reason, including constant-internal invalid_choice. Derivation still follows drop/override rules, returns diff null with a typed diagnostic, leaves the source unchanged, and preserves unrelated source/model checks (3.11, 5.3, 6).
- **T1 (tables):** reference data is declared as typed tables in the model and supplied as rows from outside (file `source` or injected `DataSource`). Rows are validated strictly, pinned per session with `dataHash`/`dataVersion`, refreshed only explicitly (`refreshData`, audited in `dataChanges`), embedded in snapshots and loaded fresh on derive unless `keepData`. Expressions access tables as typed CEL maps; missing keys are `unknown`. `choicesFrom` builds a parameter's choices from rows with a row filter `when` as its availability; filtered rows stay listed as unavailable so stock changes surface as conflicts. Table keys have no identifier restriction; labels come from a data column, not translations. Tables are evaluation constants, not graph nodes, and not inputs (2, 3.0, 3.3, 3.12, 4.1, 5, 6).
- **T2 (naming):** the top-level key for currency and price precision is `pricing` (previously `result`), because it holds only price settings and `result` was easily confused with the evaluated `Result` output. Future non-price settings for the export get their own keys (e.g. per-line settings on `items`, order header data under a separate key) instead of a generic container. The output type `Result`, `buildResult`, `getOrderLines` and the error target `result:total` keep their names (3.0, 3.8–3.9).

- **R1 (pre-implementation review):** reserved identifiers are a closed list (3.3). Row-filter targets are always listed with status error > undecided > ok (3.9, 3.12). Table `source` paths are excluded from `logicHash` (3.7, 5.1, 8). Embedded model sources need an injected `DataSource`, file overrides or `keepData` for table data. Per-call `dataFiles` overrides (`--data`) exist in the API, including `validate`, and are not persisted. A refused finish still persists data refreshed in that call. Result-changing engine fixes stay major bumps with documented operational cost. No concurrency control in v1. A first milestone (M1) and the CEL library gate for tables are part of section 9 (3.12, 5, 5.1, 6, 9).

Open design-review decisions: none. All review findings have approved resolutions recorded in this section. Pinned CEL behavior (signed 64-bit, typed table rows), runtime schemas and required golden cases remain implementation/verification work under section 9; design resolution does not claim that verification is complete.

## 11. Example Models (sketches)
### 11.1 Desk (basic)
This is the first golden fixture (WP 0). It covers a constant and a calculated internal, a parameter with a default (`depth`), a rule-computed constraint with a static fallback (`width.max`), a guard that is `unknown` until `material` is set (`oak_surcharge`), a calculated output (`area`), and two locales. Layout as in 3.7: `desk/model.yaml`, `desk/i18n/en.yaml`, `desk/i18n/de.yaml`.
```yaml
# model.yaml
schemaVersion: 1
model: desk
modelVersion: "1.0"
defaultLocale: en
translations: {en: i18n/en.yaml, de: i18n/de.yaml}
sections:
  - {id: dimensions}
  - {id: material_group}
variables:
  - {id: material, kind: parameter, type: choice, mandatory: true, section: material_group,
     choices: [{id: oak}, {id: steel}]}
  - {id: width, kind: parameter, type: int, min: 60, max: 200, mandatory: true, section: dimensions}
  - {id: depth, kind: parameter, type: int, min: 40, max: 100, default: 60, section: dimensions}
  - {id: area, kind: output, type: float, precision: 2, section: dimensions}   # square metres
  - {id: pricePerCm, kind: internal, type: float, default: 1.5}   # constant internal
  - {id: isPremium, kind: internal, type: bool}                   # calculated internal
  - {id: deskArticle, kind: internal, type: string, default: "DSK-100"}
  - {id: premiumArticle, kind: internal, type: string, default: "DSK-OAK"}
rules:
  - {id: area_calc, target: area, expr: 'double(width) * double(depth) / 10000.0'}
  - {id: premium_flag, target: isPremium, expr: 'material == "oak"'}
  - {id: max_steel, target: width.max, when: 'material == "steel"', expr: '160'}   # otherwise the declared max (200) applies
pricing: {currency: EUR, pricePrecision: 2}
items:
  - {id: desk, article: deskArticle, price: 'double(width) * pricePerCm'}
  - {id: oak_surcharge, when: isPremium, article: premiumArticle,
     price: 'double(width) * pricePerCm * 0.2', data: {taxClass: '"standard"'}}
```
```yaml
# i18n/en.yaml (texts via derived translation ids; internals need no texts, see 3.7)
dimensions.name: Dimensions
material_group.name: Material
material.name: Material
material.choices.oak: Oak
material.choices.steel: Steel
width.name: Width
depth.name: Depth
area.name: Area
desk.name: Desk
oak_surcharge.name: Oak surcharge
```
```yaml
# i18n/de.yaml
dimensions.name: Abmessungen
material_group.name: Material
material.name: Material
material.choices.oak: Eiche
material.choices.steel: Stahl
width.name: Breite
depth.name: Tiefe
area.name: Fläche
desk.name: Schreibtisch
oak_surcharge.name: Eichenaufpreis
```
Notes:
- `width` and `depth` are `int` and `pricePerCm` is `float`, so expressions need `double(...)` (strict typing, see 3.3).
- The price exists only as position prices (3.8): the result total is the single source of truth.
- Expected behaviour as golden steps: with nothing set, `area` is `unknown`, `oak_surcharge` is `undetermined` (its guard `isPremium` is `unknown`) and `desk` is `incomplete`, so the result `total` is `null`. With `material: steel`, `width.max` becomes 160, so a width of 180 is an `out_of_range` conflict (rule `max_steel`) that taints `area` and the `desk` position. With `material: oak` the surcharge position becomes `ok`.

### 11.2 Cut-to-size panel (tables)
This fixture covers reference data from a product data service (3.12). The service provides article ids, base prices (EUR per m²), stock and the maximum panel size. The model offers products in stock as choices and calculates the price from the selected product's base price and the entered length and width. Layout: `panel/model.yaml`, `panel/data/products.yaml`, `panel/i18n/en.yaml`, `panel/i18n/de.yaml`. In production an injected `DataSource` replaces the data file.
```yaml
# model.yaml
schemaVersion: 1
model: panel
modelVersion: "1.0"
defaultLocale: en
translations: {en: i18n/en.yaml, de: i18n/de.yaml}
tables:
  - id: products
    key: articleId
    columns:
      - {id: basePrice, type: float}            # EUR per m²
      - {id: availableQuantity, type: int}
      - {id: label, type: string}
      - {id: maxLength, type: int}              # mm
      - {id: maxWidth, type: int}               # mm
    source: data/products.yaml
sections:
  - {id: material_group}
  - {id: dimensions}
variables:
  - {id: product, kind: parameter, type: choice, mandatory: true, section: material_group,
     choicesFrom: {table: products, when: 'row.availableQuantity > 0', textColumn: label}}
  - {id: length, kind: parameter, type: int, min: 100, max: 3000, mandatory: true, section: dimensions}   # mm
  - {id: width, kind: parameter, type: int, min: 100, max: 2000, mandatory: true, section: dimensions}    # mm
  - {id: quantity, kind: parameter, type: int, min: 1, default: 1}
  - {id: area, kind: output, type: float, precision: 3, section: dimensions}   # m² per panel
  - {id: cutFee, kind: internal, type: float, default: 4.5}                    # constant internal, per panel
rules:
  - {id: area_calc, target: area, expr: 'double(length) * double(width) / 1000000.0'}
  - {id: length_max_product, target: length.max, expr: 'products[product].maxLength'}
  - {id: width_max_product, target: width.max, expr: 'products[product].maxWidth'}
  - {id: quantity_max_stock, target: quantity.max, when: 'products[product].availableQuantity > 0',
     expr: 'products[product].availableQuantity'}   # guarded: no stock means "no bound", not min > max (4.3)
pricing: {currency: EUR, pricePrecision: 2}
items:
  - {id: panel, article: product, quantity: quantity,
     price: 'products[product].basePrice * area',
     data: {label: 'products[product].label'}}
  - {id: cutting, article: '"SRV-CUT"', quantity: quantity, price: cutFee}
```
```yaml
# data/products.yaml (row list of table products; normally delivered by the product data service)
- {articleId: "PNL-OAK-19", basePrice: 48.0, availableQuantity: 12, label: "Oak veneer 19 mm", maxLength: 2800, maxWidth: 2070}
- {articleId: "PNL-MDF-19", basePrice: 21.5, availableQuantity: 0, label: "MDF 19 mm", maxLength: 2800, maxWidth: 2070}
- {articleId: "4711-00", basePrice: 35.9, availableQuantity: 3, label: "Birch plywood 18 mm", maxLength: 2500, maxWidth: 1250}
```
```yaml
# i18n/en.yaml (no texts for table choices: labels come from the data, 3.12)
material_group.name: Material
dimensions.name: Dimensions
product.name: Panel
length.name: Length (mm)
width.name: Width (mm)
quantity.name: Quantity
area.name: Area per panel (m²)
panel.name: Panel, cut to size
cutting.name: Cutting service
```
```yaml
# i18n/de.yaml
material_group.name: Material
dimensions.name: Abmessungen
product.name: Platte
length.name: Länge (mm)
width.name: Breite (mm)
quantity.name: Anzahl
area.name: Fläche je Platte (m²)
panel.name: Platte, auf Maß geschnitten
cutting.name: Zuschnitt
```
Session usage (CLI): `confx start panel/model.yaml` pins the rows from `data/products.yaml`; `confx start panel/model.yaml --data products=today.json` uses another file; `confx state --session <id> --refresh-data` reloads them.

Notes:
- `product` holds the real article id (`4711-00` is a valid key, although it is not a valid identifier), so the `panel` item uses it directly as `article`. No mapping rules and no per-product variables are needed. A new product in the service is a new row, not a model change, and does not change `logicHash`.
- Base price, stock and maximum sizes are lookups on the selected row. While `product` is unset, these lookups are `unknown`, so the `length.max`/`width.max` targets are `undecided` and the declared bounds apply.
- `quantity` declares a default, so its value node depends on `quantity.max` and thus on `product` (4.1). There is no cycle because nothing depends on `quantity` except items.
- Expected behaviour as golden steps (data as above):
  - Nothing set: `product.choices` lists all three rows in data order. `PNL-MDF-19` has `available: false` (no stock), and every choice carries its `label`. `quantity` is 1 (default). `cutting` is `ok` (4.50), `panel` is `incomplete` (article and price unknown), so `total` is `null`.
  - `product: PNL-MDF-19`: an `unavailable` conflict (`ruleId: null`, the row filter is not a rule).
  - `product: 4711-00`, `length: 2600`: `length.max` is 2500 (rule `length_max_product`), so `length` gets an `out_of_range` conflict.
  - `product: 4711-00`, `length: 1200`, `width: 600`, `quantity: 2`: `area` is 0.72. `panel` has unit price 35.9 × 0.72 = 25.848 → 25.85 and total 51.70, `cutting` has total 9.00, so the result total is 60.70. With `quantity: 5`, `quantity.max` is 3 and `quantity` gets an `out_of_range` conflict.
  - Refresh with `4711-00` at `availableQuantity: 0` and `basePrice: 37.9`: the response carries a `data_changed` notice and `dataChanges` gains an entry. `product` gets an `unavailable` conflict, `quantity_max_stock` no longer matches (the static bound applies), and the `panel` unit price is 27.29. `finish` is refused until another product is chosen.
  - All rows at stock 0 and `product` unset: the state warns `no_available_choice` for `product`, and `finish` stays blocked by the open mandatory parameter.
  - `derive` of a finished session loads fresh data, so the diff shows changed prices and conflicts. With `--keep-data`, the derived session reproduces the original totals.
