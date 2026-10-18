import {
  CommandId,
  PierActionError,
  type PierLanding,
  type PierRunActionInput,
  type PierRunActionResult,
  type ThreadId,
  type VcsStatusRemoteResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitManager from "../../git/GitManager.ts";
import { createdPullRequestKey } from "../../git/linkCreatedPullRequest.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as VcsStatusBroadcaster from "../VcsStatusBroadcaster.ts";
import * as PierCli from "./PierCli.ts";
import { pierLanding, pierRefName } from "./PierVcsDriver.ts";

const COMMIT_PATCH_MAX_OUTPUT_BYTES = 1_000_000;
const EDIT_LETTERS = { added: "A", modified: "M", deleted: "D" } as const;

/** What a pier checkout does in place of git's commit, push and pull request. */
export class PierActions extends Context.Service<
  PierActions,
  {
    readonly run: (
      input: PierRunActionInput,
    ) => Effect.Effect<PierRunActionResult, PierActionError>;
    /** Links the landing's pull request to the thread, as git links one it created. */
    readonly linkLanding: (threadId: ThreadId, landing: PierLanding) => Effect.Effect<void>;
    /** Links a polled landing's pull request to the threads whose checkout is `cwd`. */
    readonly linkPolledLanding: (
      cwd: string,
      remote: VcsStatusRemoteResult | null,
    ) => Effect.Effect<void>;
  }
>()("t3/vcs/pier/PierActions") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* PierCli.PierCli;
  const gitManager = yield* GitManager.GitManager;
  const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  // A pull request appears once per landing, then each poll sees it again.
  const linked = new Set<string>();
  const failedAttempts = new Map<string, number>();

  const linkLanding: PierActions["Service"]["linkLanding"] = (threadId, landing) => {
    const pullRequest = landing.pullRequest;
    if (pullRequest === null) return Effect.void;
    const key = `${threadId}\u0000${pullRequest.url}`;
    if (linked.has(key)) return Effect.void;
    // The same id each time, so a link the user removed is not made again. A
    // rejected id stays rejected, so each retry after a failure gets a new one.
    const attempt = failedAttempts.get(key) ?? 0;
    const commandId = CommandId.make(
      `server:pier-landing-link:${threadId}:${pullRequest.url}${attempt === 0 ? "" : `:${attempt}`}`,
    );
    return Effect.gen(function* () {
      const thread = yield* engine.getThreadShell(threadId);
      if (thread === null) return;
      const project = Option.getOrUndefined(yield* projects.getShell(thread.projectId));
      const pullRequestKey = createdPullRequestKey(
        { pr: { status: "created", number: pullRequest.number, url: pullRequest.url } },
        project,
      );
      if (pullRequestKey === null) return;
      yield* engine.dispatch({
        type: "thread.pull-request.link",
        commandId,
        threadId,
        ...pullRequestKey,
        source: "created",
      });
      linked.add(key);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.sync(() => failedAttempts.set(key, attempt + 1)).pipe(
              Effect.andThen(
                Effect.logWarning("failed to link a pier landing's pull request", {
                  threadId,
                  cause,
                }),
              ),
            ),
      ),
    );
  };

  const linkPolledLanding: PierActions["Service"]["linkPolledLanding"] = (cwd, remote) => {
    const landing = remote?.pier?.landing;
    if (!landing?.pullRequest) return Effect.void;
    return engine.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(
          snapshot.threads.filter((thread) => thread.worktreePath === cwd),
          (thread) => linkLanding(thread.id, landing),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to link a pier landing's pull request", { cwd, cause }),
      ),
    );
  };

  const run: PierActions["Service"]["run"] = Effect.fn("PierActions.run")(function* (input) {
    const fail = (detail: string, cause?: unknown) =>
      new PierActionError({
        action: input.action,
        cwd: input.cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const fromCli = Effect.mapError((error: PierCli.PierCliError) => fail(error.detail, error));
    const localStatus = cli.localStatus(input.cwd).pipe(fromCli);

    const writeMessage = Effect.fn("PierActions.writeMessage")(function* (
      local: PierCli.PierStatus,
    ) {
      if (input.message !== undefined) return input.message;
      // From the pinned changeset to the files on disk: exactly what the commit takes.
      const diff = yield* cli
        .diff(input.cwd, [local.pinned], COMMIT_PATCH_MAX_OUTPUT_BYTES)
        .pipe(fromCli);
      const { subject, body } = yield* gitManager
        .suggestCommitMessage({
          cwd: input.cwd,
          threadId: input.threadId,
          refName: pierRefName(local),
          summary: [
            ...local.uncommitted.map((edit) => `${EDIT_LETTERS[edit.status]}\t${edit.path}`),
            // A settled conflict with no edit on disk still changes its file.
            ...(local.resolved ?? [])
              .filter(
                (resolution) => !local.uncommitted.some((edit) => edit.path === resolution.path),
              )
              .map(
                (resolution) => `${resolution.took === "delete" ? "D" : "M"}\t${resolution.path}`,
              ),
          ].join("\n"),
          patch: diff.patch,
        })
        .pipe(Effect.mapError((error) => fail(error.message, error)));
      return body.length > 0 ? `${subject}\n\n${body}` : subject;
    });

    const commitEdits = Effect.fn("PierActions.commitEdits")(function* (required: boolean) {
      const local = yield* localStatus;
      // Conflicts `pier resolve` settled are committed even with no file edited.
      if (local.uncommitted.length === 0 && (local.resolved ?? []).length === 0) {
        if (required) return yield* fail("There are no edits to commit.");
        return { pinned: local.pinned, commit: null };
      }
      const message = yield* writeMessage(local);
      const committed = yield* cli.commit(input.cwd, message).pipe(fromCli);
      return {
        pinned: committed.id,
        commit: { id: committed.id, subject: message.split("\n", 1)[0] ?? message },
      };
    });

    const land = (changeset: string, options?: { readonly cancel?: boolean }) =>
      cli.land(input.cwd, changeset, options).pipe(fromCli, Effect.map(pierLanding));

    const result: PierRunActionResult = yield* Effect.gen(function* () {
      const none = { action: input.action, commit: null, landing: null, rebase: null };
      switch (input.action) {
        case "commit":
          return { ...none, commit: (yield* commitEdits(true)).commit };
        case "land":
          return { ...none, landing: yield* land((yield* localStatus).pinned) };
        case "commit_land": {
          const committed = yield* commitEdits(false);
          return { ...none, commit: committed.commit, landing: yield* land(committed.pinned) };
        }
        case "cancel_land":
          return {
            ...none,
            landing: yield* land((yield* localStatus).pinned, { cancel: true }),
          };
        case "rebase": {
          const rebased = yield* cli.rebase(input.cwd).pipe(fromCli);
          return {
            ...none,
            rebase: {
              rebased: rebased.rebased.length,
              head: rebased.head,
              conflicts: rebased.conflicts ?? [],
            },
          };
        }
      }
    }).pipe(Effect.ensuring(broadcaster.refreshStatus(input.cwd).pipe(Effect.ignore)));

    // A withdrawn landing's pull request is no work of the thread's to link.
    if (input.threadId !== undefined && result.landing !== null && input.action !== "cancel_land") {
      yield* linkLanding(input.threadId, result.landing);
    }
    return result;
  });

  return PierActions.of({ run, linkLanding, linkPolledLanding });
});

export const layer = Layer.effect(PierActions, make).pipe(Layer.provide(PierCli.layer));

/** Links a landing's pull request when a status poll first sees it, which can be well after `pier land`. */
export const layerLandingLinks = Layer.effectDiscard(
  Effect.gen(function* () {
    const actions = yield* PierActions;
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    yield* broadcaster.remoteStatusChanges.pipe(
      Stream.runForEach(({ cwd, remote }) => actions.linkPolledLanding(cwd, remote)),
      Effect.forkScoped,
    );
  }),
);
