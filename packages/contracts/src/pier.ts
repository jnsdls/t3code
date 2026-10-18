import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Where a pier landing request is, named as `pier land --json` names it. */
export const PierLandingState = Schema.Literals([
  "pending",
  "ready",
  "pushing",
  "pr_open",
  "merging",
  "landed",
  "flagged",
  "denied",
  "replaced",
  "cancelled",
]);
export type PierLandingState = typeof PierLandingState.Type;

/** A landing pier is still working on, which abandoning its changeset would pull out from under. */
export const PIER_OPEN_LANDING_STATES: ReadonlySet<PierLandingState> = new Set([
  "pending",
  "ready",
  "pushing",
  "pr_open",
  "merging",
]);

export const PierLandingPullRequest = Schema.Struct({
  number: PositiveInt,
  url: Schema.String,
  /** Reviewers whose latest review approves, or asks for changes. */
  approvals: NonNegativeInt,
  changesRequested: NonNegativeInt,
  checks: Schema.Struct({
    pending: NonNegativeInt,
    passing: NonNegativeInt,
    failing: NonNegativeInt,
  }),
});
export type PierLandingPullRequest = typeof PierLandingPullRequest.Type;

export const PierLanding = Schema.Struct({
  id: NonNegativeInt,
  tip: Schema.String,
  state: PierLandingState,
  /** Why it is flagged or denied. */
  reasons: Schema.Array(Schema.String),
  /** The commit it landed as on main. */
  landed: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(PierLandingPullRequest),
});
export type PierLanding = typeof PierLanding.Type;

/** What the pier server says of a checkout's pinned changeset. */
export const PierCheckoutRemoteStatus = Schema.Struct({
  pinned: Schema.String,
  /** The checkout sits on main's tip, with nothing of its own to land. */
  pinnedIsMain: Schema.Boolean,
  /** Main was force-pushed past the checkout's base; only a rebase reaches it again. */
  mainRewritten: Schema.Boolean,
  landing: Schema.NullOr(PierLanding),
  /** Why the server could not say where main, the landing or the conflicts stand. */
  serverError: Schema.NullOr(Schema.String),
  /** Paths the chain leaves conflicted and `pier resolve` has not settled. */
  conflicts: Schema.Array(Schema.String),
});
export type PierCheckoutRemoteStatus = typeof PierCheckoutRemoteStatus.Type;

export const PierAction = Schema.Literals([
  "commit",
  "land",
  "commit_land",
  "cancel_land",
  "rebase",
]);
export type PierAction = typeof PierAction.Type;

export const PierRunActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: PierAction,
  /** The commit message; generated from the diff when missing. */
  message: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
  threadId: Schema.optional(ThreadId),
});
export type PierRunActionInput = typeof PierRunActionInput.Type;

export const PierRunActionResult = Schema.Struct({
  action: PierAction,
  commit: Schema.NullOr(Schema.Struct({ id: Schema.String, subject: Schema.String })),
  landing: Schema.NullOr(PierLanding),
  rebase: Schema.NullOr(
    Schema.Struct({
      rebased: NonNegativeInt,
      head: Schema.String,
      conflicts: Schema.Array(Schema.String),
    }),
  ),
});
export type PierRunActionResult = typeof PierRunActionResult.Type;

export class PierActionError extends Schema.TaggedError<PierActionError>()("PierActionError", {
  action: PierAction,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
