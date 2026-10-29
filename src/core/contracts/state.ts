import { z } from "zod";

// Public output contracts, specs/MISSION.md 3.9. Zod schemas are the source of truth; types are inferred.

export const Id = z.string();
export type Id = z.infer<typeof Id>;

export const TargetId = z.string();
export type TargetId = z.infer<typeof TargetId>;

export const Value = z.union([z.number(), z.string(), z.boolean(), z.array(z.string()), z.null()]);
export type Value = z.infer<typeof Value>;

export const VariableKind = z.enum(["parameter", "output", "internal"]);
export type VariableKind = z.infer<typeof VariableKind>;

export const VariableType = z.enum(["int", "float", "string", "bool", "choice"]);
export type VariableType = z.infer<typeof VariableType>;

export const VariableStatus = z.enum(["known", "unset", "unknown", "error"]);
export type VariableStatus = z.infer<typeof VariableStatus>;

export const VariableSource = z.enum(["input", "default", "constant", "rule", "none"]);
export type VariableSource = z.infer<typeof VariableSource>;

export const TargetStatus = z.enum(["ok", "undecided", "error"]);
export type TargetStatus = z.infer<typeof TargetStatus>;

export const ConflictKind = z.enum(["out_of_range", "pattern_mismatch", "unavailable", "invalid_choice"]);
export type ConflictKind = z.infer<typeof ConflictKind>;

export const PositionStatus = z.enum(["ok", "undetermined", "incomplete", "error"]);
export type PositionStatus = z.infer<typeof PositionStatus>;

export const ResultStatus = z.enum(["final", "provisional"]);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const SessionStatus = z.enum(["unfinished", "finished"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ChoiceState = z.strictObject({
  id: Id,
  nameKey: z.string().nullable(),
  label: z.string().optional(),
  available: z.boolean(),
});
export type ChoiceState = z.infer<typeof ChoiceState>;

export const DefaultRejected = z.strictObject({
  reason: ConflictKind,
  ruleId: z.string().nullable(),
});
export type DefaultRejected = z.infer<typeof DefaultRejected>;

export const VariableState = z.strictObject({
  id: Id,
  kind: VariableKind,
  type: VariableType,
  section: Id.nullable(),
  nameKey: z.string(),
  descriptionKey: z.string(),
  value: Value,
  status: VariableStatus,
  source: VariableSource,
  multiple: z.boolean(),
  mandatory: z.boolean(),
  available: z.boolean(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  choices: z.array(ChoiceState).optional(),
  choicesFrom: Id.optional(),
  tainted: z.boolean(),
  errorDerived: z.boolean(),
  defaultRejected: DefaultRejected.optional(),
});
export type VariableState = z.infer<typeof VariableState>;

export const TargetState = z.strictObject({
  rules: z.array(z.string()),
  active: z.string().nullable(),
  status: TargetStatus,
});
export type TargetState = z.infer<typeof TargetState>;

export interface SectionState {
  id: Id;
  nameKey: string;
  descriptionKey: string;
  parent: Id | null;
  variables: Id[];
  children: SectionState[];
}
export const SectionState: z.ZodType<SectionState> = z.lazy(() =>
  z.strictObject({
    id: Id,
    nameKey: z.string(),
    descriptionKey: z.string(),
    parent: Id.nullable(),
    variables: z.array(Id),
    children: z.array(SectionState),
  }),
);

export const Conflict = z.strictObject({
  variable: Id,
  choice: Id.nullable(),
  kind: ConflictKind,
  ruleId: z.string().nullable(),
  causedBy: z.array(Id),
  root: z.boolean(),
});
export type Conflict = z.infer<typeof Conflict>;

export const ErrorTarget = z.union([
  z.literal("result:total"),
  z.templateLiteral(["position:", z.string()]),
  TargetId,
]);
export type ErrorTarget = z.infer<typeof ErrorTarget>;

export const ErrorField = z.enum(["when", "article", "quantity", "price", "total", "data", "bounds"]);
export type ErrorField = z.infer<typeof ErrorField>;

export const EvalError = z
  .strictObject({
    target: ErrorTarget,
    ruleId: z.string().nullable(),
    message: z.string(),
    field: ErrorField.optional(),
    dataKey: z.string().optional(),
  })
  .refine((e) => e.dataKey === undefined || e.field === "data", {
    message: "dataKey is only allowed with field data",
  });
export type EvalError = z.infer<typeof EvalError>;

export const Warning = z.discriminatedUnion("kind", [
  z.strictObject({ variable: Id, kind: z.literal("default_rejected"), reason: ConflictKind, ruleId: z.string().nullable() }),
  z.strictObject({ variable: Id, kind: z.literal("no_available_choice") }),
]);
export type Warning = z.infer<typeof Warning>;

export const Blocker = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open_mandatory"), ref: Id }),
  z.strictObject({ kind: z.literal("conflict"), ref: Id, conflictIndex: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("error"), ref: ErrorTarget, errorIndex: z.int().nonnegative() }),
  z.strictObject({
    kind: z.literal("position"),
    ref: z.templateLiteral(["position:", z.string()]),
    status: z.enum(["undetermined", "incomplete"]),
  }),
]);
export type Blocker = z.infer<typeof Blocker>;

export const Completion = z.strictObject({
  canFinish: z.boolean(),
  blockers: z.array(Blocker),
});
export type Completion = z.infer<typeof Completion>;

export const State = z.strictObject({
  variables: z.record(Id, VariableState),
  targets: z.record(TargetId, TargetState),
  sections: z.array(SectionState),
  conflicts: z.array(Conflict),
  errors: z.array(EvalError),
  warnings: z.array(Warning),
  completion: Completion,
});
export type State = z.infer<typeof State>;

export const DataEntry = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.strictObject({ textKey: z.string() }),
  z.null(),
]);
export type DataEntry = z.infer<typeof DataEntry>;

export const ResultPosition = z.strictObject({
  id: Id,
  status: PositionStatus,
  article: z.string().nullable(),
  nameKey: z.string(),
  descriptionKey: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  total: z.number().nullable(),
  data: z.record(z.string(), DataEntry),
  origin: z.array(Id),
  tainted: z.boolean(),
  errorDerived: z.boolean(),
});
export type ResultPosition = z.infer<typeof ResultPosition>;

export const Result = z.strictObject({
  status: ResultStatus,
  currency: z.string().nullable(),
  items: z.array(ResultPosition),
  total: z.number().nullable(),
  conflicts: z.array(Conflict),
  errors: z.array(EvalError),
});
export type Result = z.infer<typeof Result>;
