# CEL library verification (WP 2 gates)

Library: `@marcbachmann/cel-js` **8.0.0**, pinned exactly, with a local patch
(`patches/@marcbachmann__cel-js@8.0.0.patch`, registered in `pnpm-workspace.yaml`).
Executable evidence: `tests/cel/cel-library.test.ts`. Any library upgrade must keep that suite green
and re-evaluate the patch.

Verdict: **both gates pass.** Signed 64-bit behavior conforms to MISSION.md 3.4 after the patch and
one validator check. Typed table rows work as specified in 3.12, so 3.12 needs no revision.

## 1. Signed 64-bit int

| Behavior | Unpatched 8.0.0 | Resolution |
|---|---|---|
| `+`, `-`, `*` overflow | `numeric_overflow` error | OK |
| unary `-` of `-2^63` | returns `2^63` silently | **patched**: overflow check |
| `-2^63 / -1` | returns `2^63` silently | **patched**: overflow check |
| `-2^63 % -1` | `0` | OK |
| `/` and `%` by zero | `division_by_zero` / `modulo_by_zero` | OK |
| `/`, `%` rounding | truncate toward zero (`-7/2 = -3`, `-7%2 = -1`) | OK, matches CEL |
| `int(double)` out of range (e.g. `9.3e18`, `2^63`) | returns an out-of-range bigint | **patched**: requires `-2^63 <= v < 2^63` |
| `int(NaN)`, `int(Infinity)` | `numeric_overflow` | OK |
| `int(string)` | range checked (`int_conversion_error`) | OK |
| literal `-9223372036854775808` | parsed as `-(9223372036854775808)`, evaluates to `-2^63` | OK |
| literal `-9223372036854775809` | after patch: `numeric_overflow` at runtime | validator rejects statically too |
| standalone literal `9223372036854775808` (and larger) | accepted as `2^63` | **validator must reject** (see below) |
| int input outside range | `numeric_overflow` | OK; inputs are also rejected earlier (safe range, 4.7) |
| int variable given a JS number | `variable_type_mismatch` | OK, the engine converts inputs to bigint |

The parser cannot reject the out-of-range literal itself: it needs the context of a direct unary
minus to allow `-2^63`. **Validator rule (WP 7, code `invalid_expression`):** an int literal greater
than `2^63 - 1` is an error unless it equals `2^63` and is the direct operand of unary minus.

Built-in operators and functions cannot be overridden through the API (`already registered` /
`overlaps`), which is why the fixes are a package patch and not engine registrations. The patch should
be proposed upstream; when an upstream release includes it, drop the patch and re-pin.

**Publishing caveat:** `pnpm patch` only applies inside this repository. Users installing the published
`confx` package would get the unpatched library. Before the first release, the fix must be upstream,
or the patched library must be bundled or forked under its own name.

## 2. Doubles

Double arithmetic follows IEEE: `1.0/0.0` is `Infinity`, `0.0/0.0` is `NaN`, overflow is `Infinity`,
all without an error. MISSION.md 3.4 requires non-finite numeric results to be evaluation errors. The
engine checks every rule result, attribute result and item field result and reports a non-finite
double as an evaluation error on that target. Non-finite **intermediate** values are not caught by
this check (e.g. `1.0/0.0 > 5.0` is `true`); see open question below.

## 3. Unknown and presence

- A missing variable throws `EvaluationError` with `code: "unknown_variable"` (message
  `Unknown variable: <name>`). Detection uses the `code`, not the message.
- Short-circuiting works in both directions (`false && x`, `true || x`).
- `has(set.x)` on a `map` variable works with plain objects and `Map`. `check()` accepts
  `has(set.widht)`, so the validator's AST scan for `set.<name>` (3.3) is required.
- `min`, `max`, `abs`, `round` are **not** built in (`no_matching_overload`), so the engine registers
  them with exactly the 3.4 signatures. Overloads are type-checked strictly (`min(1, 2.5)` fails).

## 4. Tables (gate for 3.12)

- Register one type per table with a class constructor and typed fields:
  `registerType(<typeName>, {ctor, fields: {<column>: <celType>}})`, then
  `registerVariable(<tableId>, "map<string, <typeName>>")`.
- Row values **must be instances of that class**, held in a `Map` (or object) keyed by row key.
  Plain objects fail at runtime with `field_type_mismatch`. Int columns must be bigint.
- `products[product].basePrice` type-checks to `double`; an unknown column fails `check()`.
- A missing key throws `code: "no_such_key"`, distinct from `unknown_variable`: the engine maps it
  to `unknown` (3.3).
- `in`, `exists`, `all`, `size` work on table maps. Keys like `4711-00` and `A.12/3` work.
- `row` can be registered as a variable of the row type for `choicesFrom.when`.
- Type names have a library-defined syntax (`R` was rejected, `products_Row` accepted). The engine
  generates internal type names that cannot clash with model ids and that pass this check, and
  covers the naming scheme with a test.
- Note: `check()` accepts `products[1]` (int key on `map<string, …>`). Harmless at runtime (missing
  key), but the validator may add a check later.

## 5. Globally bound names

The global environment binds these **variable** names, which cannot be re-registered:
`bool`, `bytes`, `cel`, `double`, `google`, `int`, `list`, `map`, `null_type`, `optional`, `string`,
`type`, `uint`. Of these, `cel`, `google` and `optional` were missing from the reserved list in 3.3
and have been added. Function names (`size`, `has`, `join`, …) do not block variables of the same
name; the reserved list keeps its conservative function entries anyway.

The library also offers features outside the 3.3 type mapping (`uint` literals like `1u`, bytes,
timestamps, durations, optional types). Optional types are disabled by default. Whether the validator
rejects the remaining ones is a WP 7 decision; `check()` alone does not.

## Open question

Should non-finite **intermediate** doubles also be errors? Options:
1. Check results only (current reading of 3.4): simple, but `1.0/0.0 > 5.0` evaluates to `true`.
2. Extend the patch so double `+ - * /` throw on a non-finite result: strict and consistent with the
   int overflow behavior, but deviates further from upstream CEL.
