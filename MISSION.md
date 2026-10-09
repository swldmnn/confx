# confX: Mission and Planning Base

## 1. Mission
confX is a generic, embeddable evaluation engine for configurable products (CPQ).
Product logic lives in a declarative YAML **model**. The engine holds no domain knowledge.
Every time a parameter changes, the engine re-evaluates the whole model and returns a consistent session state.

**Non-goals (v1):** UI, quote/offer documents, tax handling, mixed currencies, user management, multi-user concurrency, a database, a network server (the API is a library plus CLI first; a REST wrapper can come later).

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
| Result | Export format for external systems (e-shop): a list of positions plus the total. Separate from the internal state, never an input to rules. |

**Key design principle:** session state is derived. Only the inputs are stored (a set of parameter and internal values). The full state is recomputed by evaluating the model on every call. This keeps storage trivial and makes evaluation deterministic and testable.

## 3. Model Specification (draft)

### 3.0 Model file: top-level keys
A model is one YAML file with these top-level keys. Unknown keys are a schema error (5.1).
| Key | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Integer, version of the model format (5.1). Read first, selects the schema. |
| `model` | no | Short model id (pattern as variable ids), informational, e.g. `desk`. Shown in states and snapshots, never interpreted. |
| `modelVersion` | yes | Free-form label set by the author (5.1). Informational only. |
| `defaultLocale` | yes if `translations` is present | Fallback locale (3.7). Must be a key of `translations`. |
| `translations` | no | Map locale to translation file, relative to the model file (3.7). Without it the model has no texts and all ids fall back to themselves. |
| `sections` | no | List of sections (3.6). |
| `variables` | yes | List of variables (3.1). At least one. |
| `rules` | no | List of rules (3.2). |
| `result` | yes if `positions` is present | `currency` and optional `pricePrecision` (3.8). |
| `positions` | no | List of position templates (3.8). |

Ids of variables, sections and positions share one namespace (3.1, 3.6, 3.8). `set` is reserved (3.3).

### 3.1 Variable fields
| Field | Notes |
|---|---|
| `id` | Unique in the model. Pattern `[A-Za-z][A-Za-z0-9_]*`, so it is usable in expressions. `set` is reserved (presence map, see 3.3), as are CEL keywords. |
| `kind` | `parameter`, `output`, `internal` |
| `type` | `int`, `float`, `string`, `bool`, `choice`. `bool` is allowed for all kinds. |
| `name`, `description` | Not stored in the model. Texts live in the translation files (see 3.7). Optional `nameKey` / `descriptionKey` override the translation id, otherwise it is derived from the variable id. |
| `section` | Optional id of a section the variable belongs to (see 3.6). Ungrouped variables sit at the top level. |
| `min`, `max` | int/float parameters only |
| `format` | string parameters only, regex |
| `precision` | float only, optional integer n >= 0. Calculated values of the variable (and its `min`/`max` rule results) are rounded to n decimals. See 3.4. |
| `choices` | choice only: list of `{id, nameKey?}`. Texts come from the translation files (3.7). Value is the choice id. |
| `multiple` | choice only, bool. Value is a list of choice ids. |
| `mandatory` | parameters only, default false |
| `default` | internal (and optionally parameter). Internal: the constant value, and the fallback when no rule is active. Parameter: a starting suggestion, see 3.5. |
| `order` | Optional number. Defines the "next open parameter" sequence among its siblings, see the order rules in 3.6. Without it, declaration order applies after all siblings with `order`. |

**Allowed fields and rule targets per kind.** A field outside this matrix is a validator error. Declaration fields:
| Field | parameter | internal | output |
|---|---|---|---|
| `id`, `kind`, `type`, `section` | yes | yes | yes |
| `min`, `max` (int/float) | yes | no | no |
| `format` (string) | yes | no | no |
| `precision` (float) | yes | yes | yes |
| `choices`, `multiple` (choice) | yes | yes | yes |
| `mandatory` | yes | no | no |
| `default` | optional | optional (the constant, or the fallback of a calculated internal) | no |
| `order` | yes | no | no |
| `nameKey`, `descriptionKey` | yes | yes | yes |

Rule targets:
| Target | parameter | internal | output |
|---|---|---|---|
| `<id>` (assign value) | no (inputs only) | yes (makes it calculated) | yes (required, at least one rule) |
| `<id>.min`, `<id>.max` (int/float) | yes | no | no |
| `<id>.available` | yes | no | no |
| `<id>.choices.<c>.available` | yes | no | no |

Consequences:
- **Only parameters have constraints and availability.** They exist to check and shape user input. Internals and outputs are computed values, so they are never unavailable, and there is no "unavailable output". An author who wants a value to disappear conditionally models that in the positions (`when:`) or with a guard on the rule that assigns it.
- `precision` applies to all kinds: it rounds calculated values, and the `min`/`max` rule results of a parameter (3.4).
- `choices` on an internal or output declares the allowed result ids of a calculated choice value. A rule result outside the list is an evaluation error (4.6).
- `format`, `choices` and `multiple` are static: they are not rule targets (3.5).
- `mandatory` and `order` only matter for the question flow (`getNextOpenParameter`), so they are parameter-only.

**Value semantics per type** (what "set" means and how values are checked):
- **`format` (string):** a JavaScript `RegExp` (with the `u` flag, no other flags) that must match the **whole** value. The engine anchors it, so `[A-Z]{3}` means exactly three capital letters, and authors do not write `^...$`. An invalid regex is a validator error. A mismatch is a conflict of kind `pattern_mismatch`.
- **String parameters:** the empty string is a **value**, it counts as set (for `mandatory`, `has(set.x)`). Authors who need non-empty input declare `format: ".+"`, so an empty string becomes a `pattern_mismatch` conflict.
- **Multiple choice (`multiple: true`):**
  - The value is a list of choice ids in the order given, without duplicates. A duplicate id in an input is a wrong-value error (exception, 4.7), not a conflict.
  - An **empty list counts as unset** (not set for `mandatory`, no entry in `set`). Setting `[]` is the same as `resetParameter`.
  - There are no count limits in v1 (`min`/`max` are int/float only). Authors who need "at most 2" cannot express it yet.
  - `default` is a non-empty list of valid choice ids, without duplicates (validator).
  - Checks are per selected id: an id that is not in `choices` is a conflict of kind `invalid_choice`, an id that is currently unavailable is a conflict of kind `unavailable`. Both conflicts carry `choice: <id>` (3.9), so several selected ids give several conflicts.
- **`precision` and constants:** `precision` rounds values the engine **calculates** (rule results, and the `min`/`max` results of a parameter, 3.4). A constant internal's `default` is not calculated, so it is never rounded: the validator requires it to have at most `precision` decimals (error otherwise). A constant internal overridden at start is an input, and inputs are never rounded (3.4).

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
An internal with an assigning rule is calculated. Its `default` is the fallback when no rule is active. If an unguarded rule exists, the default is never used (validator warns).

**Multiple rules per target, first match wins.** A target is a variable value or an attribute (`min`, `max`, `available`, `choices.<id>.available`). A target may have several rules, each with an optional boolean `when:` guard.
1. Rules are tried in declaration order. The first rule whose guard is true is the active rule, and only its `expr` is evaluated.
2. A rule without `when:` always matches. It acts as the default and must be the last rule for its target. A rule after an unguarded rule is unreachable, which is a validator **error**.
3. Overlapping guards are allowed (that is the point of first-match), and there is no overlap warning.
4. No active rule: the target falls back to the static declaration (no constraint, declared `min`/`max`, available). For an internal the declaration is its `default`. For an output there is none, so the value is `unknown`. The validator warns if an output, or an internal without `default`, has only guarded rules.
5. A guard that evaluates to `unknown` makes it undecidable which rule applies, so the target is treated like "no active rule" (rule 4): it falls back to the static declaration. Per kind: `min`/`max` the declared bounds (none if undeclared), `available` the declared availability (available unless stated otherwise), a value target its declaration (an internal's `default`, `unknown` for an output or an internal without `default`). An undecidable guard is therefore never less restrictive than "no rule matched". The same applies when the active rule's `expr` evaluates to `unknown` for an attribute target (e.g. `width.max` computed from an unset parameter). Example: `width` (declared max 200) with a `max_steel` guard on a still unset `material` stays capped at 200 until `material` is set. The target is marked `undecided` in the state, with `active: null`, so consumers can tell "no rule matched" from "guard not yet decidable". CEL short-circuiting still helps, e.g. `material == "steel" && x > 3` is `false` once the material is known not to be steel.
6. A guard that is not a bool or that errors is an evaluation error for that rule, reported as such (4.6). It is not treated as inactive, and the target is treated like `unknown` (static declaration for attributes).
There is no combining of constraints. Authors needing several limits at once write one expression (e.g. `min(a, b)`).

### 3.3 Expression language
**Decided:** CEL (Common Expression Language) via `@marcbachmann/cel-js` (pinned version). No custom parser, no `eval`.
- Syntax is plain CEL: arithmetic, comparison, `&&`, `||`, `!`, ternary `cond ? a : b` (there is no `if()`), `in` for lists and multi-choice.
- Custom functions registered by the engine: `min`, `max`, `round`, `abs` (if not built in). There is no `isSet()` function, see "Presence map" below.
- Variables are declared in the CEL environment by their model type, so expressions are statically type-checked by `validateModel` (`env.check()`).
- **Type mapping:** `int` is CEL `int` (`bigint`), `float` is `double` (`number`), `string` is `string`, `bool` is `bool`, a single `choice` is `string` (the choice id), and a `multiple` choice is `list<string>`. `set` is a `map` (see below).
- **Choice id literals are checked (best effort):** the validator scans the AST for comparisons of a choice variable with a string literal (`material == "oka"`, `material != "x"`, `"oka" in material`, `material in ["a", "b"]`). A literal that is not one of the variable's choice ids is a validator **error**, because the comparison can never be true and is almost certainly a typo. Comparisons with non-literals cannot be checked.
- Typing is strict, as in CEL: `int` values are `bigint`, `float` values are `number`, and mixing them needs an explicit conversion (e.g. `double(width) * 1.5`). The engine converts input and output values according to the declared type. See also numeric semantics (3.4).
- **`unknown` semantics:** an unset variable is left out of the evaluation context. CEL evaluates normally, so short-circuiting works (`false && unsetVar` is `false`, `true || unsetVar` is `true`). If the missing variable is actually needed, the library throws `EvaluationError` "Unknown variable: <name>". The engine catches this and the result is `unknown`. Other evaluation errors (division by zero, type mismatch) are reported as errors, not as `unknown`.
- **Presence map:** a plain function `isSet(x)` cannot work, because CEL evaluates its argument first and an unset `x` throws before the function runs. Instead the engine passes a map variable `set` (declared as `map`) in the context. It has an entry `<id>: true` for every variable that currently has a value, and no entry for the others. Authors write `has(set.x)`, which is plain CEL, uses public library API only, and short-circuits like any other expression (`has(set.x) && x > 3` is `false` when `x` is unset).
  - "Has a value" means: set by the user, set by a default (3.5, a defaulted parameter counts as set, consistent with `mandatory`), a constant internal, or calculated to a known value. An `unknown` or errored variable has no entry.
  - `set` is a reserved identifier and cannot be a variable, section or position id.
  - The `set` map is untyped, so `check()` cannot catch typos like `has(set.widht)`. The validator scans the AST for `set.<name>` accesses and reports a name that is not a variable id as an error. Dynamic access such as `set["x"]` is also checked when the key is a literal, and anything else is rejected.
  - Detection of the missing-variable error relies on the library's error type and message. Pin the library version and cover this with a test.
- Unknown for `available` rules means the declared availability (available by default), until the guard or expression is known to be false (see 3.2 rule 5).

### 3.4 Numeric semantics
- `int` is exact (`bigint` in CEL). `float` is an IEEE double. There is no decimal type in v1.
- Comparisons are exact. There is no epsilon or hidden tolerance. Authors get stable comparisons through rounding.
- **`precision: n`** on a float variable: every calculated value of that variable, and the results of its `min`/`max` rules, are rounded to n decimals, so downstream rules, guards and constraint checks see the rounded value.
- **`round(x, n)`** is a registered custom function for explicit rounding in expressions. It uses the same mode as `precision`.
- **Rounding mode:** half away from zero, implemented on the decimal string representation of the double (avoids artifacts such as `1.005` rounding down). `Number.prototype.toString` returns exponent forms for very small and very large values (`1e-7`, `1.5e-7`, `1e21`). The implementation first expands these into plain decimal digit strings and then rounds on the digits, so rounding never depends on the exponent form. The result `-0` is normalized to `0`. `NaN` and infinities are evaluation errors on that target. Golden cases cover `1.005`, `2.5`, `-2.5`, `1e-7`, `1.5e-7`, `1e21` and `-0.4` with `precision: 0`.
- User-entered values are never rounded. Inputs are stored as given, so the audit record is exact.
- Floats are for dimensions, weights and prices at normal scale, not for exact accounting. Values that are compared (thresholds, guards, constraints) should be rounded or declared with `precision`.
- **Integer limits:** two limits apply and both are documented for authors. (1) CEL `int` is a signed 64-bit integer, and arithmetic overflow beyond it is an evaluation error (4.6), not a wrap. (2) The engine's serialization limit is tighter, see the next point. An integer input outside the safe range is rejected when it is set (wrong-value exception, 4.7), so it never enters a session. Conversions like `double(i)` for `|i| > 2^53` lose precision as usual for doubles.
- **Serialization:** `int` values are written as JSON numbers within the safe range (+-(2^53 - 1)). Outside it, the engine reports an evaluation error on that variable instead of losing precision. `float` values are JSON numbers after `precision` rounding.
- **Later evaluation item:** a `decimal` type (custom CEL type with operator overloads, e.g. backed by `decimal.js`). The trigger is a model that cannot be written cleanly with `precision`. A spike would first test whether the CEL library supports custom types and operator overloads. It is a new `type` value, so it can be added without breaking existing models.

### 3.5 Defaults and internals after start
- **Parameter `default`** is a starting suggestion, not an input. An unset parameter with a default evaluates as if set to the default, and the state marks it `source: default`. The default is not stored in the session inputs, so unfinished sessions follow the model's default, and the snapshot at `finish` freezes it.
  - It counts as set for `mandatory` and `getNextOpenParameter`. Authors who want explicit confirmation should not declare a default.
  - `resetParameter` returns the parameter to its default (or to unset if there is none).
  - The default must satisfy the static constraints (validator).
  - **Rejected defaults:** the validator only checks static constraints, so a default can still be unusable at runtime: the parameter is unavailable, or the default violates a dynamic constraint (a rule-computed `min`/`max`, a `choices.<id>.available` rule). The default is then **not used**: the parameter evaluates as unset, for downstream rules, positions and `mandatory`. It is not a conflict, because the user set nothing, so it does not block `finish` by itself (a mandatory parameter left unset still does). It is never silent: the variable carries `defaultRejected: {reason, ruleId}` (`reason`: `unavailable`, `out_of_range`, `pattern_mismatch`, `invalid_choice`, same vocabulary as conflict kinds), and the state lists it in a `warnings` entry `{variable, kind: "default_rejected", reason, ruleId}`. The default is re-checked on every evaluation, so it is used again as soon as it becomes valid.
- **Internals:** a constant internal can be overridden once at `startSession` / `deriveSession` and is then fixed for the session. Calculated internals cannot be overridden (initial values for them are rejected). There is no `setInternal` / `updateInternal` in v1. To change an internal, start a new session with `deriveSession` and different initial values. A `setInternal` can be added later without breaking anything.
- **`choices` is not a rule target.** The choice list is static. Rules may only change `choices.<id>.available`.

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
| Section name / description | `<sectionId>.name` / `<sectionId>.description` | `nameKey` / `descriptionKey` |
| Position name / description | `<positionId>.name` / `<positionId>.description` | `nameKey` / `descriptionKey` |
| Position data text | none, always explicit | `textKey` expression in the `data` entry (3.8) |

Overrides allow one text to be shared (e.g. several variables using `common.width`).
- **Resolution:** requested locale, then `defaultLocale`, then the id (the derived or explicit key itself) as a last resort. The fallback is reported by `localize` (the `fallbacks` list, 3.9), not as an error.
- **Core stays pure:** `loadModel(yamlText, translations)` takes the translation file contents as `{locale: yamlText}`. The `ModelSource` (session layer) reads the files listed under `translations`. The core never touches paths.
- **Hashes:** `hashModel` returns two hashes. `logicHash` covers the model file **without the text configuration**, i.e. the parsed model minus the top-level keys `translations` and `defaultLocale` (everything that can change evaluation), and is the integrity check. `textHash` covers the text configuration and is informational: `defaultLocale` plus all translation files (locale and file content, in sorted locale order, file paths excluded). Adding, removing or re-pointing a locale therefore changes `textHash` only. The finish snapshot embeds the model and the translation files, so audits show the texts as they were. A translation fix therefore never blocks a session.
- **Locale is not an input of evaluation:** `evaluate` and `buildResult` are locale-free. They emit translation ids (`nameKey`, `descriptionKey`, choice keys, `{textKey: <id>}` data entries), never texts, and report no locale fallbacks. A separate pure function `localize(model, stateOrResult, locale) -> localized` resolves the ids to texts (resolution above), adds `name` / `description` fields next to the ids, and reports the fallbacks it applied (requested locale to `defaultLocale` to id). Texts are presentation, never inputs to rules, and are not stored in sessions. The session layer's `getState` / `getOrderLines` take an optional `locale` and call `localize` on the result.
- **Validator:** every declared locale file is parsed, and the `defaultLocale` must be declared. **Required texts** are the names of parameters, outputs, sections, positions and choices. Descriptions are always optional, and **internals need no texts** (they are helper values), so they never produce missing-text warnings. A missing required text per locale is a warning. For `defaultLocale` a missing name is a warning too, because the id fallback applies. Unused translation ids are warnings, which catches typos and renamed ids. To avoid false positives for ids used by dynamically built `textKey` expressions (3.8), only ids in the **derived-id namespace** are checked: an id whose first segment is a declared variable, section or position id (`widht.name` next to a declared `width`) but which matches no derived or explicit key. Free-form ids with any other first segment (`info.premium`, `common.width`) are never reported as unused. An id counts as used if it is derived from a declared id, set as `nameKey` / `descriptionKey`, or appears as a string literal in a `textKey` expression.
- Because the texts left the model, adding or fixing a translation, adding a locale, or changing `defaultLocale` does not change `logicHash` (the keys `translations` and `defaultLocale` are excluded from it, see "Hashes"). It only changes `textHash` (state flag `textsChanged`, informational, see 5.1).

### 3.8 Positions and result (order lines)
The **state** is for internal processing. The **result** is for external systems, e.g. mapping to e-shop order items. The result is produced from the evaluated state by `buildResult` (6.1) and has no influence on evaluation: positions cannot be referenced by rules, so the dependency graph is unchanged.
```yaml
result:
  currency: EUR          # one currency per model, no mixing
  pricePrecision: 2      # optional, default 2, rounding as in 3.4
positions:
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
| `when` | Optional boolean guard. False: no position. `unknown`: position is listed with status `undetermined`. Non-bool or error: evaluation error. |
| `article` | Required. CEL expression of type string, typically an internal variable holding the article number, or an expression selecting between articles. Article numbers are defined by the model, never by the engine. |
| `quantity` | Optional, CEL int, default 1. Must be >= 1, otherwise an evaluation error. |
| `price` | Required. CEL float, **unit price**. Negative values (discounts) are allowed. |
| `data` | Optional map `key -> entry`. An entry is either a CEL expression (value is string, int, float or bool; a string literal needs inner quotes, e.g. `'"standard"'`) or a **text entry** `{textKey: <CEL string expression>}`. A text entry evaluates the expression to a translation id. The locale-free result carries the id (`{"textKey": "info.premium"}`), and `localize` turns it into the text for the requested locale (3.7: locale, then `defaultLocale`, then the id itself). This is how data that does not come from user choices (tax class, delivery class, shop category, informational text, ...) reaches the external system. Plain expressions are never translated. Example: `note: {textKey: 'isPremium ? "info.premium" : "info.standard"'}`. |
| `nameKey` / `descriptionKey` | Texts via the translation files (3.7), derived ids `<positionId>.name` / `<positionId>.description`. Informational text is therefore localized like everything else. |

**Independence from sections and parameters:** positions have their own list. One parameter may produce several positions, several parameters may produce one, and a position may exist without any user choice. The premium handle example: `premium_handle` is its own position with its own article, present only if `handle == "premium"`. If the standard handle is also an article, a second position `standard_handle` with the opposite guard lists it.

**Result shape** (`getOrderLines`):
```json
{
  "status": "final | provisional",
  "currency": "EUR",
  "positions": [
    {"id": "premium_handle", "status": "ok", "article": "WIN-HND-PRM", "nameKey": "premium_handle.name", "descriptionKey": "premium_handle.description",
     "quantity": 2, "unitPrice": 39.00, "total": 78.00,
     "data": {"taxClass": "standard"}, "origin": ["handle", "sashCount"], "tainted": false}
  ],
  "total": 498.00,
  "conflicts": [], "errors": []
}
```
`buildResult` returns this locale-free form. `localize` adds `name` / `description` next to the keys and replaces `{"textKey"}` data entries with texts.
- **Order:** declaration order of `positions`. Only positions whose guard is true, `unknown` or errored are listed (with status `ok`, `undetermined` or `error`).
- **`origin`:** derived by the engine from the dependency graph, not authored. It lists the parameters the position (guard, article, quantity, price, data) transitively depends on. Like taint, it is static (4.4): it lists every parameter reachable in the graph, including ones a short-circuited branch did not actually use. For traceability only.
- **Rounding:** `unitPrice` is rounded to `pricePrecision` (mode from 3.4). `total` of a position is `round(unitPrice * quantity)` to `pricePrecision`. The result `total` is the sum of the positions' `total` values and nothing else. The sum is computed in **integer minor units** (each position total times 10^`pricePrecision`, as an exact integer from its decimal string), added as integers and converted back, so float artifacts such as `0.1 + 0.2` cannot appear. The same applies to the negative totals of discounts.
- **Total is the single source of truth for the price.** There is no separate overall price output: prices live in the position `price` expressions, and the result `total` is their sum. The validator warns if positions exist but none has a price.
- **Position status:** `ok`, `undetermined` (guard `unknown`), `incomplete` (article, quantity or price `unknown`), `error` (guard, article, quantity or price raised an evaluation error, or depends on an errored value that was actually needed). Unknown fields are `null`. If any listed position is not `ok`, the result `total` is `null`. It is never a silent partial sum.
- **Result status:** `final` for a finished session, `provisional` otherwise (passed to `buildResult` by the session layer, 3.9). A provisional result is a preview and must not be used to create an order. `getOrderLines` is allowed at any time.
- **Taint and conflicts:** a position is `tainted` if any expression it used depends on a conflicting value (4.4). The result carries the session `conflicts` and the evaluation `errors` of the positions.
- **Snapshot:** `finish` stores the locale-free result in the snapshot (5.2). A finished session is served from the snapshot and localized on request.
- **Reserved for later:** repeating positions (e.g. `forEach` over a multi-choice parameter, or an `article` on a choice as shorthand). Not in v1. Adding either needs a `schemaVersion` bump (5.1).

### 3.9 State and result schema (normative)
This is the one definition of the output shapes. 6.2 and §10 refer to it. Golden tests pin it down. Written as TypeScript types, the zod schemas are derived from them. Every output of the core is **locale-free** (3.7): texts appear as ids (`*Key`), and `localize` adds the text fields listed at the end.

**Enums:**
| Enum | Values |
|---|---|
| `VariableStatus` | `known` (has a value), `unset` (parameter without value or usable default), `unknown` (derived value not decidable, e.g. missing input or undecided output), `error` (evaluation error, 4.6) |
| `VariableSource` | `input` (user or start value), `default` (parameter default, 3.5), `constant` (constant internal at its default), `rule` (calculated by a rule), `none` |
| `TargetStatus` | `ok`, `undecided` (guard or `expr` `unknown`, 3.2 rule 5), `error` |
| `ConflictKind` | `out_of_range`, `pattern_mismatch`, `unavailable`, `invalid_choice` |
| `PositionStatus` | `ok`, `undetermined`, `incomplete`, `error` (3.8) |
| `ResultStatus` | `final`, `provisional` |
| `SessionStatus` | `unfinished`, `finished`. This says only whether `finish` ran. Whether it can run is `completion.canFinish`. |

**State** (core output of `evaluate`):
```ts
type Id = string;                       // variable, section or position id
type TargetId = string;                 // "<id>" | "<id>.min" | "<id>.max" | "<id>.available" | "<id>.choices.<c>.available"
type Value = number | string | boolean | string[] | null;   // int/float -> number, multiple choice -> string[], unknown -> null

interface State {
  variables: Record<Id, VariableState>;
  targets: Record<TargetId, TargetState>;     // only targets that have at least one rule
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
  mandatory: boolean;
  available: boolean;                          // effective availability, always true for internals and outputs (3.1)
  min: number | null; max: number | null;      // effective bounds, null = none (always null for internals and outputs)
  choices?: { id: Id; nameKey: string; available: boolean }[];
  tainted: boolean; errorDerived: boolean;     // static, 4.4 and 4.6
  defaultRejected?: { reason: ConflictKind; ruleId: string | null };   // 3.5
}

interface TargetState {
  rules: string[];                             // rule ids in declaration order
  active: string | null;                       // null: static declaration, or undecided
  status: TargetStatus;
}

interface SectionState {
  id: Id; nameKey: string; descriptionKey: string; parent: Id | null;
  variables: Id[]; children: SectionState[];
}

interface Conflict   { variable: Id; choice: Id | null; kind: ConflictKind; ruleId: string | null; causedBy: Id[]; root: boolean }   // 4.4, `choice` is set for per-id conflicts of multiple choice (3.1)
interface EvalError  { target: TargetId | `position:${Id}`; ruleId: string | null; message: string; root: boolean }   // 4.6
interface Warning    { variable: Id; kind: "default_rejected"; reason: ConflictKind; ruleId: string | null }   // 3.5
interface Blocker    { kind: "open_mandatory" | "conflict" | "error"; ref: Id | TargetId }                     // reasons for `canFinish: false`
```
- **Rule ids:** a rule without `id` gets the generated id `<target>#<n>` (n = position among the rules of that target), so every `ruleId` and `active` is a string or `null`.
- **`canFinish`:** true if all mandatory available parameters have a value, there are no conflicts and there are no relevant errors (4.6). `blockers` lists the reasons (the `finish` refusal in 6.2 returns the same list). Positions that are not `ok` do not block `finish` by themselves, only their errors do.
- **Model validator warnings** are a separate list (section 7) and are not part of the state. `warnings` here are runtime warnings only.

**Session state** (`getState`, session layer) adds the session context around the same shape:
```ts
interface SessionState extends State {
  sessionId: string; model: string | null; status: SessionStatus; modelVersion: string;
  flags: { modelChanged: boolean; engineChanged: boolean; textsChanged: boolean };   // 5.1
  acceptedChanges: AcceptedChange[];                                                  // 5.1
}
```
A finished session returns the snapshot's state in this shape. `completion` of a finished session is `{canFinish: true, blockers: []}`.

**Result** (core output of `buildResult`, 3.8):
```ts
interface Result {
  status: ResultStatus; currency: string;
  positions: ResultPosition[];
  total: number | null;                        // null if any listed position is not ok
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
`buildResult` gets `status` from its caller's context: the session layer passes `final` when the session is finished, otherwise `provisional`. The core function takes it as a parameter, so it stays pure.

**Localized form** (`localize`, 3.7): the same objects, plus `name` and `description` next to every `nameKey` / `descriptionKey` (variables, choices, sections, positions), `{textKey}` data entries replaced by the resolved text, and a top-level `fallbacks: {key: Id; requested: string; usedLocale: string | null}[]` (`null` = the id itself was used).

## 4. Evaluation Semantics
These rules define how the model is evaluated. They are implemented in WP 3 and 4 and pinned down by golden tests.
1. **Dependency graph:** build a DAG from the variables referenced in each rule expression. Evaluate in topological order. A cycle is a model error (found by `validate`).
   - **Nodes are targets, not variables:** `x` (value), `x.min`, `x.max`, `x.available` and `x.choices.<c>.available`. A parameter's value is an input node with no dependencies. The constraint check of a parameter (4.3) depends on its attribute nodes, but its value does not depend on them.
   - **Edges:** a rule's target node depends on the nodes of every variable its `when` and `expr` reference. A reference to variable `x` in an expression means the **value** node of `x`. Attributes are never referenced directly from expressions. A `set.x` access (presence map, 3.3) counts as a reference to the value node of `x`, so `has(set.x)` creates the same edge as `x` itself.
   - **Why:** at variable level, `width.max` depending on `material` while `material.choices.oak.available` depends on `width` would look like a cycle `width <-> material`, although the target graph is acyclic. Only cycles between target nodes are model errors.
   - Positions and the result sit on top of the graph and are never dependencies (3.8).
2. **Unset inputs:** a rule that references an unset parameter produces `unknown` (null propagation). It is not an error. Outputs depending on unset inputs are `unknown`.
3. **Constraint application:** compute the effective `min/max/available` for each parameter first, then validate values against them.
4. **Conflicts:** a set value that violates its effective constraints (out of range, regex mismatch, unavailable, invalid choice) is reported as a **conflict**. The value is kept, not silently dropped. The session cannot be finished while conflicts exist (root and cascaded alike): `completion.canFinish` is false (3.9).
   - **Constraints are always applied exactly as computed**, even if computed from a conflicting value. Taint is information on top, never a reason to suppress or alter a constraint.
   - **Taint:** every variable whose evaluation transitively *depends on* a conflicting value gets `tainted: true` (in addition to its normal status). Dependence is **static**: it follows the dependency graph edges (4.1), i.e. every variable referenced in the rule's `when` and `expr`, whether or not the run actually used it. This over-approximates. With short-circuiting, `false && x` still depends on `x`, so a conflict on `x` can taint a target whose value did not actually use `x`. Static taint is deterministic, cheap and needs no value tracking inside CEL. Its only failure mode is a false positive, never a missed taint. Its value is still computed and shown. Taint propagates along the dependency graph, including through constraints and guards. Consumers decide how to present it (e.g. do not offer a tainted price for purchase). Dynamic tracking (only the references actually evaluated) is a possible later refinement and would not change the output shape.
   - **Conflict shape:** `{variable, choice, kind, ruleId, causedBy, root}`. `choice` is the selected choice id for per-id conflicts of a multiple choice (3.1), otherwise `null`.
     - `kind`: `out_of_range`, `pattern_mismatch`, `unavailable`, `invalid_choice`.
     - `ruleId`: the active rule that produced the violated constraint, or `null` if it comes from the static declaration.
     - `causedBy`: ids of conflicting variables the violated constraint statically depends on (transitively, via the dependency graph, so the same over-approximation as taint). Empty for a root conflict.
     - `root`: true if `causedBy` is empty. This is a presentation flag only. Cascaded conflicts are not suppressed, so UIs can show root problems first while the full list stays available.
5. **Unavailable parameters:** they are not required for completion even if mandatory.
   - A value set by the user on an unavailable parameter is reported as a conflict of kind `unavailable` and kept (it is user input). The state still shows the user's value (`source: input`) together with the conflict. For downstream evaluation (rules, guards, positions, `set` presence map) it is treated as **unset**, so a hidden parameter cannot influence the rest of the model. The conflict still blocks `finish` until the user resets the value or it becomes available again.
   - A **default** on an unavailable parameter is not used and not a conflict. It is reported as a rejected default (3.5), so it stays traceable.
   - Taint (4.4) follows the same rule: because an unavailable value is not used downstream, it taints nothing beyond its own conflict.
6. **Evaluation errors:** division by zero, type mismatch, a guard that is not a bool, an int outside the safe range and similar errors are reported per target (with the rule id) and do not crash the session. An error is not `unknown`: it is a separate outcome with its own status.
   - **Value of an errored target:** a value target gets status `error` and value `unknown` (null). For `min`/`max`/`available`/`choices.<id>.available` an error means the effective attribute falls back to the static declaration, the same as an `unknown` guard (3.2 rule 5). The error is reported, so the problem stays visible.
   - **Propagation:** every target whose evaluation transitively depends on an errored target gets `errorDerived: true`, analogous to taint (4.4). Dependencies are the static graph edges (4.1). The dependent evaluates normally with the errored variable left out of the context (like `unknown`), so it becomes `unknown` only if it actually needs the value, and short-circuiting still applies. `errorDerived` is information only and never suppresses a constraint.
   - **Error shape:** `{target, ruleId, message, root}`. `root` is true for the target that raised the error, false for errors raised by evaluating with a missing errored input (these are not reported again, only flagged `errorDerived`).
   - **Which errors block `finish`:** every error on a target that is relevant. A target is not relevant if it belongs to a parameter that is currently unavailable (its value and attributes) and no relevant target depends on it. Errors in positions whose guard is true or `unknown` are always relevant. Errors in irrelevant targets are still listed in the state, but do not block `finish`.
   - **Variable `status` for this case:** `error` (the enum is defined in 3.9).
7. **Setting any parameter at any time** is always accepted and then re-evaluated. Validation problems are returned as state, not exceptions. Exceptions are only for unknown ids and wrong values (wrong type, duplicate ids in a multiple choice, an integer outside the safe range), and for session-level errors (finished session, missing model file, 5).

## 5. Session
- `sessionId` is a generated id.
- Storage v1: one JSON file per session, `<dir>/<sessionId>.json`. Writes are **atomic**: the file is written to a temporary file in the same directory, flushed, then renamed over the target, so a crash never leaves a half-written session. A missing store directory is created on first save.
- Session file: `{sessionId, modelPath, logicHash, textHash, modelVersion, schemaVersion, engineVersion, inputs, status, createdAt, updatedAt, finishedAt?, derivedFrom?, acceptedChanges, snapshot?}`.
  - `updatedAt` is set by every command that changes the file. `finishedAt` is set by `finish` and equals the snapshot timestamp. All times come from the injected clock (6.1).
  - `derivedFrom` is `null` for a session started with `start`, otherwise `{sessionId, mode: "current" | "embedded" | "path", sourceLogicHash}` (the source session, which model it was evaluated against, and the source's `logicHash`). It is the link of the audit trail described in 5.3. It is also copied into the snapshot.
- **`modelPath`** is resolved against the working directory at `start` and stored as an **absolute** path. If the file is gone or moved, a command that loads an unfinished session fails with `model_not_found`. It can be re-pointed with `--model <path>` (library: `modelPath` option) on any such command. The hash checks of 5.1 then apply to the new file as usual. Finished sessions never read `modelPath`.
- Storage sits behind a small `SessionStore` interface (load/save/delete) so other backends can be added later. `save` must be atomic as above.
- Finished sessions are locked: `set`, `reset` and a second `finish` are rejected after `finish` (error `session_finished`, CLI exit code 5). They stay immutable as an audit record.

### 5.1 Versioning
- `schemaVersion`: integer, declared in the model file. It is the version of the YAML model format. The engine has a constant list of supported versions (e.g. `SUPPORTED_SCHEMA_VERSIONS = [1]`) next to one schema per version. The loader reads `schemaVersion` first and picks the matching schema.
- `modelVersion`: free-form label set by the model author. Informational only, the engine never interprets it.
- `engineVersion`: semver of the evaluator (including the pinned CEL library). Recorded in sessions and snapshots, not declared by models. A change that alters evaluation results is a major bump, guarded by golden tests.
- `logicHash` is the real integrity check. It excludes the top-level keys `translations` and `defaultLocale`. `textHash` covers those and the translation files, and is informational only.

Mismatch behavior when loading an unfinished session:
| Case | Behavior |
|---|---|
| Unsupported `schemaVersion` | Hard error, no override. Newer than known: "requires a newer confX". Older and dropped: "no longer supported". `validateModelFile` reports the same. |
| `logicHash` differs | Error, overridable with `force` (`--force` in the CLI). The state is flagged `modelChanged`. No migrations in v1. |
| `textHash` differs only | No error, no `force` needed. The state is flagged `textsChanged` (informational). The session then uses the current texts. |
| `engineVersion` major differs | Error, overridable with `force`. The state is flagged `engineChanged`. |
| `engineVersion` minor/patch differs | Warning only. |
| Finished session | Served from the snapshot, no checks needed. |

**`force` lifecycle:** `force` accepts the change **once**. The command that was run with it re-evaluates against the current model, then the session stores the current `logicHash`, `textHash`, `modelVersion` and `engineVersion` and appends an entry to `acceptedChanges`: `{at, from: {logicHash, modelVersion, engineVersion}, to: {...}}`. Later commands run without `force`, because stored and current values match again. Inputs are not touched, so conflicts caused by the new model show up as normal state. A forced session can be finished. Its snapshot carries `acceptedChanges`, so an audit shows that the model or engine changed mid-session, and the state is flagged `modelChanged` / `engineChanged` as long as `acceptedChanges` is not empty. `textHash`-only changes are not recorded there (they need no `force`).

Schema compatibility: every change to the model format bumps `schemaVersion`, including a new optional key and any change in the meaning of existing fields. The validator rejects unknown keys, so an older engine gives a clean error on a newer model instead of silently ignoring a key. Only changes outside the format (e.g. translation texts, engine internals) leave it unchanged.

### 5.2 Snapshot on `finish`
`finish` stores a self-contained snapshot: the final evaluated state and the final result (3.8), both in the **locale-free** form, the inputs, `acceptedChanges`, `derivedFrom`, `logicHash`, `textHash`, `modelVersion`, `schemaVersion`, `engineVersion`, a timestamp, and the **full embedded model including all translation files**. Audits then work even if the model file changed or is gone, and the snapshot can be rendered in any declared locale later with `localize`.
- The snapshot is a record, never live state. Live state is always recomputed from the inputs.
- Numbers: `int` values are `bigint` internally and JSON cannot represent them. The serialization rule is in 3.4.

### 5.3 Deriving sessions
A finished session is never reopened. Two use cases are supported by creating a **new** session from its inputs:
1. **Variation** ("same thing, a little different"): extract the inputs and start a new session, which stays editable. This is no re-evaluation of the old session, only an input transfer.
2. **Re-evaluation** ("configured 3 weeks ago, buying now, prices may have changed"): evaluate the stored inputs against the **current** model (or optionally the embedded one) and compare with the snapshot.

Both use the same primitive: `deriveSession(sessionId, {modelPath?, useEmbeddedModel?, carryDefaults?, force?})`.
- **Source may be finished or unfinished.** A finished source has a snapshot. For an unfinished source there is no snapshot, so the diff baseline is a fresh evaluation of its stored inputs against the model it was last evaluated with (the model at its `modelPath`, with the checks of 5.1 applied). `useEmbeddedModel` needs a snapshot, so it is an error (`no_snapshot`) for an unfinished source.
- **Dropped vs kept.** An input is **dropped** (returned in `droppedInputs` with a reason, never silently) when it cannot be represented in the target model: `unknown_variable` (id no longer exists), `kind_changed` (no longer a parameter or constant internal, e.g. an internal became calculated or a parameter became an output), `type_changed` (the declared `type`, or `multiple`, changed). An input is **kept** and reported as a conflict when it fits the variable but violates its constraints: `out_of_range`, `pattern_mismatch`, `unavailable`, and `invalid_choice` for a choice id that was removed from `choices` (per id for multiple choice, 3.1). The test is "can the value be stored for this variable", not "is the value valid".
- **Defaults.** Defaults are not stored (3.5), so by default a derived session follows the **target** model's defaults, and a changed default shows up in the diff as a changed value with `source: default` (the diff compares effective values, not only inputs). With `carryDefaults: true` the effective default values of the original snapshot are written into the new session as explicit inputs, so a re-evaluation compares like for like. Carried defaults that no longer fit are dropped or kept by the same rules as other inputs. `carryDefaults` needs a snapshot (error `no_snapshot` otherwise). CLI flag: `--carry-defaults`.
- The new session records `derivedFrom` (5).
- The new session is unfinished. Its `finish` creates a new snapshot, and the original stays untouched. This gives an audit trail: original configuration, then re-priced order.
- The result includes a `diff` against the original snapshot (changed values, new conflicts, dropped inputs, and changed positions, articles and total). The diff is also available as pure helpers `diffState(a, b)` and `diffResult(a, b)`.
- A mismatch between the original and the target model does not need `force`, because the new session is evaluated freshly. The derive result (not the new session's own state, which starts with an empty `acceptedChanges`) carries `modelChanged` and `engineChanged` flags for information.

## 6. Architecture and API
### 6.1 Layers
1. **Core (pure, no I/O):** `loadModel(yamlText, translations)`, `validateModel(model)`, `evaluate(model, inputs) -> state`, `buildResult(model, state, status) -> result` (3.8, 3.9; `status` is `final` or `provisional`, passed by the caller so the function stays pure), `localize(model, stateOrResult, locale) -> localized` (3.7), `diffState(a, b)`, `diffResult(a, b)`, `hashModel(yamlText, translations) -> {logicHash, textHash}`, and the `engineVersion` constant. It never touches files, the clock or random ids. `evaluate` and `buildResult` are pure functions of their inputs and locale-free, which is what golden tests and WASM/browser embedding need.
2. **Session layer:** the commands in 6.2. It uses a `SessionStore` (load/save/delete) and a `ModelSource` (resolves a model path or reference to YAML text plus the translation files). It generates session ids and timestamps and performs the `logicHash` / `engineVersion` checks from 5.1.
3. **CLI:** argument parsing, JSON on stdout, exit codes. A thin wrapper over the session layer.

Rules: all non-determinism (ids, `createdAt`, snapshot time) is injected or generated in the session layer, never in the core. The boundary is enforced by a lint rule that forbids Node imports (`fs`, `path`, `crypto`, ...) in the core folder. `hashModel` therefore uses the pure-JS SHA-256 from `@noble/hashes` (§8). Packaging for v1: one npm package with separate entry points (`confx/core`, `confx` for sessions) plus the CLI bin.

### 6.2 Session API (library functions, mirrored 1:1 as CLI commands)
| Command | Behaviour |
|---|---|
| `startSession(modelPath, initialValues?)` | Allowed initial values: parameters and constant internals. Outputs and calculated internals are rejected. Returns sessionId and state. |
| `setParameter(sessionId, id, value)` | Sets the value, re-evaluates, returns the new state. |
| `resetParameter(sessionId, id)` | Removes the input value. |
| `getState(sessionId, locale?)` | Returns the `SessionState` (3.9): variables, targets, sections, conflicts, errors, warnings, `completion` (`canFinish` plus blockers), session `status`, and the `modelChanged` / `engineChanged` / `textsChanged` flags. Localized if a locale is given. |
| `getOrderLines(sessionId, locale?)` | Returns the result format (3.8): positions with article, quantity, unit price, data, and the total. Read-only, allowed on unfinished sessions (`status: provisional`). Finished sessions are served from the snapshot and localized on request. |
| `getNextOpenParameter(sessionId, {includeOptional?})` | An **open** parameter is available, has no value (`status: unset`, a usable default counts as a value, 3.5) and is mandatory, or optional if `includeOptional` is true (default false). A parameter that has a value is never open, even if it is in conflict: conflicts are reported in the state, not through this call. A parameter whose default was rejected (3.5) is unset and therefore open. Order as in 3.6. Returns the id plus valid range or choices, or null if none are open. |
| `finishSession(sessionId)` | Succeeds only if all mandatory available parameters are set and there are no conflicts or relevant errors (4.6). Otherwise returns the reasons. |
| `deriveSession(sessionId, options?)` | Creates a new unfinished session from the inputs of an existing one (finished or unfinished), against the current or embedded model. Options: `modelPath`, `useEmbeddedModel`, `carryDefaults`, `force`. Returns the new sessionId, state, `droppedInputs` and a diff against the original snapshot (or, for an unfinished source, against a fresh evaluation, 5.3). |
| `validateModelFile(modelPath)` | Session-layer wrapper (CLI command `validate`): reads the model via `ModelSource`, then calls the core `validateModel(model)`. Returns a list of errors and warnings (see 7). |

Constant internals can be overridden only at `start` or `derive`. Calculated internals cannot be overridden. `set` and `reset` apply to parameters only.

### 6.3 CLI
The CLI mirrors the session API 1:1 (`start`, `set`, `reset`, `state`, `lines`, `next`, `finish`, `derive`, `validate`) and contains no logic beyond argument parsing and output.
- **Session and store:** `--session <id>` selects the session. `--store <dir>` selects the store directory. Precedence: `--store`, then the `CONFX_STORE` environment variable, then `./.confx/`.
- **Model location:** `start` takes the model path, and the session stores it afterwards. `derive` accepts `--model <path>` to evaluate against a different model, `--embedded` to use the model embedded in the snapshot, and `--carry-defaults` (5.3). Any command that loads an unfinished session accepts `--model <path>` to re-point a moved model file (5).
- **`--force`:** applies to commands that load unfinished sessions (see 5.1). It accepts the model or engine change once and records it in the session (`acceptedChanges`), so later commands need no `--force`. `derive` never needs it.
- **Values:** `set <id> <value>` is parsed by the variable's declared type from the model: `int`, `float`, `bool`, `string`, `choice`, and multiple choices as a comma-separated list. A parse failure is a usage error (exit code 1).
- **Output:** JSON only, always on stdout. Errors are also JSON: `{"error": {"code": ..., "message": ...}}`. Human-readable diagnostics go to stderr. No pretty-print mode (use `jq`).
- **Conflicts are state, not errors.** A state with conflicts exits with 0.
- **Exit codes:**
| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error or unexpected error (including unknown variable ids and wrong values: wrong type, duplicate multiple-choice ids, integers outside the safe range) |
| 2 | Model invalid or unsupported `schemaVersion`. For `validate`: at least one **error** (warnings alone exit 0, and are listed in the JSON output) |
| 3 | Session or model file not found, or `logicHash` / engine-major mismatch (needs `--force`) |
| 4 | `finish` refused (open mandatory parameters, conflicts or errors) |
| 5 | Session is finished and locked (`set`, `reset`, `finish` rejected) |

## 7. Model Validation Checks
- YAML schema (required fields, types, unknown keys)
- Unique ids, valid id syntax
- Type-specific field rules (e.g. no `format` on int, `min <= max`, valid regex)
- Output variables must have at least one assigning rule.
- Within a target, no rule after an unguarded rule (error). `when:` must be boolean. Warning if an output, or an internal without `default`, has only guarded rules (an internal with a `default` is a valid pattern, see 3.2).
- Parameters must not be assigned (only constrained).
- Rule targets and referenced ids exist. Attribute targets are valid for the kind and type (matrix in 3.1). Fields outside the per-kind matrix are errors. Top-level keys follow 3.0.
- Expressions parse and type-check statically where possible. `set.<name>` accesses refer to existing variable ids (3.3).
- No dependency cycles
- Translation completeness: warning for missing translation ids per locale, warning for unused ids, error for a missing or unparsable file listed in `translations` (details in 3.7)
- Sections: unique ids (shared namespace with variables), existing `parent` / `section` references, no parent cycles (3.6)
- Unused internals: warning (variables used only by positions count as used)
- Positions (3.8): unique ids (shared namespace), `article` is string, `price` is float, `quantity` is int, `when` is bool, `data` values type-check (a `textKey` expression must be string; its string literals are checked against the translation files as a best effort, and keys built dynamically cannot be checked, so missing texts then show up only as the id fallback), `result.currency` present if positions exist, `pricePrecision` is an integer >= 0. Warning if no position has a price.
- Default values within the declared constraints (for multiple choice: non-empty, valid ids, no duplicates; for constant internals with `precision`: at most that many decimals, 3.1). `format` is a valid regex. Choice id literals in comparisons exist in the variable's `choices` (3.3).

## 8. Tech Decisions
- **Language:** TypeScript (npm package plus CLI, Node LTS). YAML via `yaml`. Expression language: CEL via `@marcbachmann/cel-js` (decided, see 3.3). Hashing: SHA-256 via `@noble/hashes` (pure JS, synchronous, pinned), so `hashModel` stays in the pure core without Node's `crypto` or async WebCrypto (6.1).
- **Schema validation:** `zod`, one schema per `schemaVersion`. Its inferred types are the typed model objects, and refinements cover cross-field rules. Validation runs in two stages: (1) structural checks in the schema, (2) semantic checks in plain code (unique ids, references, CEL type-check, cycles, rule order, section 7) that collect all errors instead of stopping at the first. A JSON Schema export for editor support is a possible later addition.
- **Interfaces:** the core library has no I/O (see 6.1). The session layer sits on top, and the CLI is a thin wrapper. Delivery is the library plus the CLI, with no HTTP API.
- **Testing:** golden-file tests are the main test type.
  - Layout: one folder per case, `tests/golden/<case>/` with `model.yaml`, `steps.json` (ordered API calls: `start`, `set`, `reset`, `finish`, `derive`, plus the read calls `state` (with optional locale), `lines` (with optional locale), `next` (with optional `includeOptional`) and `validate`) and `expected.json` (the output of each step: the state after commands, the returned value for read calls, so results, localized texts and order lines are covered too).
  - The runner uses the core and session layer, not the CLI, with an injected fake clock and id generator. A small separate set of CLI tests checks exit codes and JSON output.
  - `expected.json` is generated with `UPDATE_GOLDEN=1` and reviewed in the diff, never edited by hand.
  - Numbers are compared exactly (see 3.4). An engine change that alters results shows up as golden diffs.
  - Every decided rule has at least one case: `unknown` short-circuit, first-match guards, default fallback, taint with `causedBy`, parameter defaults, `deriveSession` against a changed model, and fixed `hashModel` values for a known input (so a hashing library change cannot silently alter hashes). The `logicHash` input is the canonical JSON (keys sorted, no whitespace, UTF-8) of the parsed model document with the top-level keys `translations` and `defaultLocale` removed, so comments and formatting do not matter. The `textHash` input is `defaultLocale` plus the translation files' UTF-8 bytes exactly as read, in sorted locale order (locale ids included, paths excluded). Both are hex-encoded lowercase SHA-256. Golden cases: changing only `translations` / `defaultLocale` leaves `logicHash` unchanged, and any other key change alters it.

## 9. Proposed Work Breakdown
Golden tests (section 8) are the main test type, so the runner comes first and **every package adds its own golden cases as it lands**. There is no separate test package at the end. The output shapes are fixed up front in 3.9, so state and result do not change shape between packages.
0. **Project setup and golden runner:** repo, TypeScript, lint rule for the core/session boundary (6.1), golden runner with fake clock and id generator, `UPDATE_GOLDEN=1` (section 8), the first example model (the desk, 11) as a fixture.
1. **Model schema and loader (core):** top-level keys (3.0), YAML parsing, one schema per `schemaVersion`, typed model objects (variables, sections, `result`, `positions`), translation file loading, `hashModel` with fixed hash values in golden tests.
2. **Expression engine:** CEL environment, id binding and type conversion, `unknown` via missing-variable errors, custom functions (`min`, `max`, `round`, `abs`), and the `set` presence map. (Spikes done: short-circuit, error detection and `check()` confirmed, and `has(set.x)` confirmed on `@marcbachmann/cel-js` 8.0.0.)
3. **Dependency graph and evaluator (core):** target-level DAG (4.1), topological evaluation, rule selection (first match with `when:` guards), effective constraints, defaults, `precision` rounding. Produces the `State` of 3.9, including the section tree and rule ids.
4. **Constraint checking, conflicts, taint and errors (core):** per-type validation, parameter and per-choice availability, conflict shape with `causedBy`, static taint and `errorDerived`, rejected defaults and `warnings`, `completion` / `canFinish`.
5. **i18n (core):** translation id derivation, `localize` with locale resolution and fallback reporting (3.7), section ordering and `getNextOpenParameter` order (3.6).
6. **Positions and result (core):** `buildResult`, `origin` from the dependency graph, rounding and total, position status (3.8). `diffResult` comes with 9.
7. **Model validator (core):** the checks in section 7. Can start once 1 and 2 are done and grows with 3 to 6.
8. **Session layer foundations:** `SessionStore` interface plus JSON file implementation (atomic writes), `ModelSource`, versioning and mismatch checks (5.1), `acceptedChanges`, snapshot on `finish` (5.2).
9. **Session API:** start/set/reset/state/lines/next/finish, `deriveSession`, `diffState` and `diffResult` (5.3).
10. **CLI wrapper:** commands mapped to the API, JSON output, exit codes (6.3), plus the small set of CLI tests.
11. **Docs:** model reference, including the matrices of 3.1.
12. **Evaluation items (not v1):** `decimal` type spike (3.4), multi-rule combining, dynamic taint (4.4).

Suggested order: 0 → 1 → 2 → 3 → 4, then 5, 6 and 7 (7 can start earlier), then 8 → 9 → 10 → 11. Packages 5, 6 and 7 are independent of each other once 4 is done. The core/session boundary (6.1) is enforced by the lint rule from package 0.

## 10. Decisions and Open Questions
Decided:
- TypeScript, library plus CLI (no HTTP).
- Internals are either constant (overridable at start only) or calculated by rules (not overridable). The default is the fallback when no rule is active (see 3.2, 3.5).
- Parameter `default` is a non-stored starting suggestion (see 3.5). `choices` is not a rule target. No `setInternal` in v1.
- Expression language: CEL (`@marcbachmann/cel-js`), ternary syntax, `unknown` via missing-variable errors (see 3.3).
- `bool` is a variable type.
- Numeric semantics: doubles for `float` with `precision` rounding, exact `int`, no decimal type in v1 (see 3.4).
- State output: one normative schema in 3.9. Values live in `variables`. `targets` lists the rule ids per target, marks the active one and a `status` (`active: null` means the static declaration applies or the target is undecided).
- Texts live in one translation file per locale. Translation ids are derived from variable, choice, section and position ids, with optional `nameKey` / `descriptionKey` overrides (see 3.7).
- Sections group variables as a tree and affect presentation and question order only (see 3.6).
- Rules can constrain individual choices (`<param>.choices.<choiceId>.available`) as well as `min/max/available`.
- Result format for external systems: separate from the state, built from it by `buildResult`, exposed as `getOrderLines` (3.8). Positions are declared in the model (`positions:`), independent of sections, with article, quantity, unit price and enrichment `data`. The result total (sum of the rounded position totals) is the single source of truth for the price. One currency per model, no tax in v1. `getOrderLines` works on unfinished sessions (`status: provisional`). Repeating positions are reserved for later.
- `unknown` for availability is treated as available (3.3). Rule-level `when:` guards with first-match semantics (3.2). A selected choice that becomes unavailable is kept as a conflict of kind `unavailable` (4). CLI session handling, output and exit codes (6.3).

Open: none. All findings of the design review (A to E, `MISSION_REVIEW.md`) are decided and written into this document.

## 11. Example Model (sketch)
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
result: {currency: EUR, pricePrecision: 2}
positions:
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
