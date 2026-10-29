import { z } from "zod";
import {
  AcceptedChange, BaselineUnavailable, DataChange, DataIdentity, DroppedInput, SessionDiff, ValidationDiagnostic,
} from "./audit.js";
import { Blocker, Result, SessionStatus, State, VariableState } from "./state.js";

// Session state and command response contracts, specs/MISSION.md 3.9 and 3.10.

export const SessionState = State.extend({
  sessionId: z.string(),
  model: z.string().nullable(),
  status: SessionStatus,
  modelVersion: z.string(),
  flags: z.strictObject({ modelChanged: z.boolean(), engineChanged: z.boolean(), textsChanged: z.boolean() }),
  acceptedChanges: z.array(AcceptedChange),
  data: DataIdentity.nullable(),
  dataChanges: z.array(DataChange),
});
export type SessionState = z.infer<typeof SessionState>;

export const SessionNotice = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("texts_changed"), fromHash: z.string(), toHash: z.string() }),
  z.strictObject({ kind: z.literal("engine_version_changed"), fromVersion: z.string(), toVersion: z.string() }),
  z.strictObject({
    kind: z.literal("data_changed"),
    fromHash: z.string(),
    toHash: z.string(),
    dataVersion: z.string().nullable(),
  }),
]);
export type SessionNotice = z.infer<typeof SessionNotice>;

export const sessionResponse = <T extends z.ZodType>(data: T) =>
  z.strictObject({ data, notices: z.array(SessionNotice) });
export interface SessionResponse<T> {
  data: T;
  notices: SessionNotice[];
}

export const StartData = z.strictObject({ sessionId: z.string(), state: SessionState });
export type StartData = z.infer<typeof StartData>;

export const FinishData = z.discriminatedUnion("finished", [
  z.strictObject({ finished: z.literal(true), state: SessionState, result: Result }),
  z.strictObject({ finished: z.literal(false), state: SessionState, blockers: z.array(Blocker) }),
]);
export type FinishData = z.infer<typeof FinishData>;

export const DeriveData = z.strictObject({
  sessionId: z.string(),
  state: SessionState,
  droppedInputs: z.array(DroppedInput),
  diff: SessionDiff.nullable(),
  baselineUnavailable: BaselineUnavailable.nullable(),
  flags: z.strictObject({ modelChanged: z.boolean(), engineChanged: z.boolean() }),
});
export type DeriveData = z.infer<typeof DeriveData>;

export const ValidationData = z.strictObject({ valid: z.boolean(), diagnostics: z.array(ValidationDiagnostic) });
export type ValidationData = z.infer<typeof ValidationData>;

export const NextData = VariableState.nullable();
export type NextData = z.infer<typeof NextData>;
