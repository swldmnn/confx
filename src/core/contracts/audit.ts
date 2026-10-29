import { z } from "zod";
import {
  Completion, Conflict, EvalError, Id, ResultPosition, SectionState, TargetState, Value, VariableState, VariableType, Warning,
} from "./state.js";

// Audit, diff and diagnostic contracts, specs/MISSION.md 3.11.

export const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
export type Timestamp = z.infer<typeof Timestamp>;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

export const InputDefinition = z.strictObject({
  kind: z.enum(["parameter", "internal"]),
  type: VariableType,
  multiple: z.boolean(),
});
export type InputDefinition = z.infer<typeof InputDefinition>;

export const ModelReference = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), path: z.string() }),
  z.strictObject({ kind: z.literal("embedded"), model: z.string(), translations: z.record(z.string(), z.string()) }),
]);
export type ModelReference = z.infer<typeof ModelReference>;

export const VersionIdentity = z.strictObject({
  logicHash: z.string(),
  modelVersion: z.string(),
  engineVersion: z.string(),
});
export type VersionIdentity = z.infer<typeof VersionIdentity>;

export const AcceptedChange = z.strictObject({ at: Timestamp, from: VersionIdentity, to: VersionIdentity });
export type AcceptedChange = z.infer<typeof AcceptedChange>;

export const SourceChange = z.strictObject({ at: Timestamp, from: ModelReference, to: ModelReference });
export type SourceChange = z.infer<typeof SourceChange>;

export const DataIdentity = z.strictObject({
  dataHash: z.string(),
  dataVersion: z.string().nullable(),
  loadedAt: Timestamp,
});
export type DataIdentity = z.infer<typeof DataIdentity>;

export const DataChange = z.strictObject({ at: Timestamp, from: DataIdentity, to: DataIdentity });
export type DataChange = z.infer<typeof DataChange>;

export const DerivedFrom = z
  .strictObject({
    sessionId: z.string(),
    mode: z.enum(["current", "embedded", "path"]),
    sourceLogicHash: z.string(),
  })
  .nullable();
export type DerivedFrom = z.infer<typeof DerivedFrom>;

export const StructuralInputReason = z.enum(["unknown_variable", "kind_changed", "type_changed"]);
export type StructuralInputReason = z.infer<typeof StructuralInputReason>;

export const InputIncompatibilityReason = z.enum(["unknown_variable", "kind_changed", "type_changed", "invalid_choice"]);
export type InputIncompatibilityReason = z.infer<typeof InputIncompatibilityReason>;

export const InputIncompatibility = z.strictObject({ variable: Id, reason: InputIncompatibilityReason });
export type InputIncompatibility = z.infer<typeof InputIncompatibility>;

export const DroppedInput = z.strictObject({
  variable: Id,
  value: Value,
  source: z.enum(["input", "carried_default"]),
  reason: InputIncompatibilityReason,
});
export type DroppedInput = z.infer<typeof DroppedInput>;

export const BaselineUnavailable = z.strictObject({
  kind: z.literal("incompatible_inputs"),
  inputs: z.array(InputIncompatibility),
});
export type BaselineUnavailable = z.infer<typeof BaselineUnavailable>;

// Zod cannot infer object shapes built from a generic schema, so the helpers declare their output types.
type Change<T> = { before: T; after: T };
type EntityChange<T> = { id: string; before: T | null; after: T | null };
type ListDelta<T> = { added: T[]; removed: T[] };

const change = <T extends z.ZodType>(t: T) =>
  z.strictObject({ before: t, after: t }) as unknown as z.ZodType<Change<z.infer<T>>>;
const entityChange = <T extends z.ZodType>(t: T) =>
  z
    .strictObject({ id: z.string(), before: t.nullable(), after: t.nullable() })
    .refine((c) => {
      const { before, after } = c as unknown as EntityChange<unknown>;
      return before !== null || after !== null;
    }, { message: "before and after cannot both be null" }) as unknown as z.ZodType<EntityChange<z.infer<T>>>;
const listDelta = <T extends z.ZodType>(t: T) =>
  z.strictObject({ added: z.array(t), removed: z.array(t) }) as unknown as z.ZodType<ListDelta<z.infer<T>>>;

export const StateDiff = z.strictObject({
  variables: z.array(entityChange(VariableState)),
  targets: z.array(entityChange(TargetState)),
  sections: change(z.array(SectionState)).nullable(),
  conflicts: listDelta(Conflict),
  errors: listDelta(EvalError),
  warnings: listDelta(Warning),
  completion: change(Completion).nullable(),
});
export type StateDiff = z.infer<typeof StateDiff>;

export const ResultDiff = z.strictObject({
  items: z.array(entityChange(ResultPosition)),
  itemOrder: change(z.array(Id)).nullable(),
  currency: change(z.string().nullable()).nullable(),
  total: change(z.number().nullable()).nullable(),
  conflicts: listDelta(Conflict),
  errors: listDelta(EvalError),
});
export type ResultDiff = z.infer<typeof ResultDiff>;

export const SessionDiff = z.strictObject({ state: StateDiff, result: ResultDiff });
export type SessionDiff = z.infer<typeof SessionDiff>;

export const ValidationCode = z.enum([
  "yaml_parse", "schema", "unsupported_schema_version",
  "duplicate_id", "invalid_id", "invalid_field", "invalid_default", "invalid_regex",
  "invalid_reference", "invalid_expression", "expression_type", "invalid_choice_literal",
  "dependency_cycle", "section_cycle", "unreachable_rule",
  "guarded_without_fallback", "unused_default", "missing_translation",
  "unused_translation", "translation_file", "unused_internal",
  "invalid_table", "unused_table",
]);
export type ValidationCode = z.infer<typeof ValidationCode>;

export const DataIssue = z.strictObject({
  table: Id,
  row: z.int().nonnegative().nullable(),
  key: z.string().nullable(),
  column: z.string().nullable(),
  reason: z.enum([
    "not_a_list", "not_an_object", "missing_column", "unknown_column", "wrong_type",
    "non_finite", "unsafe_integer", "empty_key", "duplicate_key", "unknown_table", "missing_table",
  ]),
});
export type DataIssue = z.infer<typeof DataIssue>;

export const ValidationDiagnostic = z.strictObject({
  severity: z.enum(["error", "warning"]),
  code: ValidationCode,
  source: z.enum(["model", "translation"]),
  locale: z.string().nullable(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  line: z.int().positive().nullable(),
  column: z.int().positive().nullable(),
});
export type ValidationDiagnostic = z.infer<typeof ValidationDiagnostic>;

export const WrongValueReason = z.enum([
  "wrong_type", "null", "non_finite", "unsafe_integer", "duplicate_choice", "invalid_choice", "empty_choice_list",
]);
export type WrongValueReason = z.infer<typeof WrongValueReason>;

export const ErrorDetails = {
  invalid_usage: z.strictObject({ argument: z.string().nullable(), reason: z.string() }),
  invalid_argument: z.strictObject({ argument: z.string(), reason: z.string() }),
  unknown_variable: z.strictObject({ variable: Id }),
  wrong_value: z.strictObject({ variable: Id, value: JsonValue, receivedType: z.string(), reason: WrongValueReason }),
  no_snapshot: z.strictObject({ sessionId: z.string(), operation: z.enum(["embedded", "carry_defaults"]) }),
  model_invalid: z.strictObject({ diagnostics: z.array(ValidationDiagnostic) }),
  unsupported_schema_version: z.strictObject({ declared: z.number(), supported: z.array(z.number()) }),
  session_not_found: z.strictObject({ sessionId: z.string() }),
  model_not_found: z.strictObject({ path: z.string() }),
  model_source_error: z.strictObject({ path: z.string(), operation: z.literal("read") }),
  model_changed: z.strictObject({ stored: VersionIdentity, current: VersionIdentity }),
  data_invalid: z.strictObject({ issues: z.array(DataIssue) }),
  data_source_error: z.strictObject({ table: Id.nullable(), reason: z.string() }),
  engine_changed: z.strictObject({ stored: VersionIdentity, current: VersionIdentity }),
  incompatible_inputs: z.strictObject({ inputs: z.array(InputIncompatibility) }),
  session_finished: z.strictObject({ sessionId: z.string(), operation: z.enum(["set", "reset", "finish"]) }),
  storage_error: z.strictObject({ sessionId: z.string().nullable(), operation: z.enum(["load", "save", "delete"]) }),
  internal_error: z.never(),
} as const;
export type ErrorDetails = { [C in keyof typeof ErrorDetails]: z.infer<(typeof ErrorDetails)[C]> };

export const ErrorCode = z.enum(Object.keys(ErrorDetails) as [keyof typeof ErrorDetails, ...(keyof typeof ErrorDetails)[]]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorPayload = z.discriminatedUnion(
  "code",
  ErrorCode.options.map((code) =>
    z.strictObject({ code: z.literal(code), message: z.string(), details: ErrorDetails[code].optional() }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
);
export type ErrorPayload = { [C in ErrorCode]: { code: C; message: string; details?: ErrorDetails[C] } }[ErrorCode];
