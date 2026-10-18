import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PierLanding,
  type PierRunActionInput,
  type VcsStatusRemoteResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as GitManager from "../../git/GitManager.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { makeFakePier, writePierCheckoutMarker } from "../testing/FakePier.ts";
import * as VcsStatusBroadcaster from "../VcsStatusBroadcaster.ts";
import * as PierActions from "./PierActions.ts";

const THREAD_ID = ThreadId.make("thread-pier");
const PULL_REQUEST_URL = "https://github.com/acme/widgets/pull/42";

const threadAt = (id: ThreadId, worktreePath: string | null) =>
  v2PullRequestThread({
    id,
    projectId: ProjectId.make("project-widgets"),
    title: "Widgets",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    pullRequests: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
  });

/** A thread's pier checkout with two uncommitted edits, and the services around it, recorded. */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pier = yield* makeFakePier;
  const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pier-actions-" });
  yield* writePierCheckoutMarker(checkout);
  const setUncommitted = (
    uncommitted: ReadonlyArray<{ path: string; status: string }>,
    resolved: ReadonlyArray<{ path: string; took: string }> = [],
  ) =>
    pier.setStatus({
      root: checkout,
      server: "http://pier.test",
      upstream: "acme/widgets",
      pinned: "cs-pinned",
      agent: "t3-0123abcd",
      cone: ["src"],
      resolved,
      uncommitted,
    });
  yield* setUncommitted([
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "added" },
  ]);

  const suggestions = yield* Ref.make<
    ReadonlyArray<Parameters<GitManager.GitManager["Service"]["suggestCommitMessage"]>[0]>
  >([]);
  const refreshed = yield* Ref.make<ReadonlyArray<string>>([]);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  // How many dispatches from now on the orchestrator turns away.
  const rejections = yield* Ref.make(0);
  const threads = [threadAt(THREAD_ID, checkout), threadAt(ThreadId.make("thread-other"), null)];

  const layer = PierActions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitManager.GitManager)({
          suggestCommitMessage: (input) =>
            Ref.update(suggestions, (all) => [...all, input]).pipe(
              Effect.as({ subject: "Add widgets", body: "" }),
            ),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          // The action's answer does not wait on a refresh that fails.
          refreshStatus: (cwd) =>
            Ref.update(refreshed, (all) => [...all, cwd]).pipe(
              Effect.andThen(
                Effect.fail(
                  new GitManagerError({ operation: "refresh", cwd, detail: "unreachable" }),
                ),
              ),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: (threadId) =>
            Effect.succeed(threads.find((thread) => thread.id === threadId) ?? null),
          getShellSnapshot: () =>
            Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads, archivedThreads: [] }),
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(
              Effect.andThen(Ref.getAndUpdate(rejections, (count) => Math.max(0, count - 1))),
              Effect.flatMap((count) =>
                count > 0
                  ? Effect.die(new Error("command rejected"))
                  : Effect.succeed({ sequence: 1, storedEvents: [] }),
              ),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({ getShell: () => Effect.succeedNone }),
        Layer.succeed(HostProcess.Environment, pier.environment),
      ),
    ),
  );
  const run = (input: Omit<PierRunActionInput, "cwd">) =>
    PierActions.PierActions.pipe(
      Effect.flatMap((actions) => actions.run({ cwd: checkout, ...input })),
      Effect.provide(layer),
    );
  const pierCalls = pier.calls.pipe(
    Effect.map((calls) => calls.map((call) => call.slice(call.indexOf("|") + 1))),
  );
  return {
    pier,
    checkout,
    layer,
    run,
    pierCalls,
    setUncommitted,
    suggestions,
    refreshed,
    dispatched,
    rejections,
  };
});

const pullRequestLanding = {
  id: 9,
  tip: "cs-committed",
  state: "pr_open",
  landed: null,
  pull_request: { number: 42, url: PULL_REQUEST_URL, reviews: [], comments: [], checks: [] },
};

describe("PierActions", () => {
  it.effect("commits with the message it was given", () =>
    Effect.gen(function* () {
      const { run, pierCalls, suggestions, refreshed, checkout } = yield* setup;
      const result = yield* run({ action: "commit", message: "Tidy the widgets" });

      assert.deepEqual(result.commit, { id: "cs-committed", subject: "Tidy the widgets" });
      assert.isNull(result.landing);
      assert.include(yield* pierCalls, "commit -m Tidy the widgets --json");
      assert.deepEqual(yield* Ref.get(suggestions), []);
      assert.deepEqual(yield* Ref.get(refreshed), [checkout]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes a commit message from the edits pier diffs against the pinned changeset", () =>
    Effect.gen(function* () {
      const { pier, run, pierCalls, suggestions } = yield* setup;
      yield* pier.setDiff("cs-pinned", "diff --git a/src/a.ts b/src/a.ts\n");
      const result = yield* run({ action: "commit", threadId: THREAD_ID });

      assert.equal(result.commit?.subject, "Add widgets");
      const [suggestion] = yield* Ref.get(suggestions);
      assert.equal(suggestion?.summary, "M\tsrc/a.ts\nA\tsrc/b.ts");
      assert.equal(suggestion?.patch, "diff --git a/src/a.ts b/src/a.ts\n");
      assert.equal(suggestion?.refName, "t3-0123abcd");
      assert.equal(suggestion?.threadId, THREAD_ID);
      assert.include(yield* pierCalls, "commit -m Add widgets --json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("commits conflicts pier resolve settled, with no file edited", () =>
    Effect.gen(function* () {
      const { run, setUncommitted, pierCalls, suggestions } = yield* setup;
      yield* setUncommitted([], [{ path: "src/a.ts", took: "main" }]);
      const result = yield* run({ action: "commit", threadId: THREAD_ID });

      assert.equal(result.commit?.id, "cs-committed");
      assert.equal((yield* Ref.get(suggestions))[0]?.summary, "M\tsrc/a.ts");
      assert.include(yield* pierCalls, "commit -m Add widgets --json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a commit with nothing to commit", () =>
    Effect.gen(function* () {
      const { run, setUncommitted, pierCalls } = yield* setup;
      yield* setUncommitted([]);
      const error = yield* Effect.flip(run({ action: "commit", message: "Nothing" }));

      assert.equal(error.detail, "There are no edits to commit.");
      assert.notInclude((yield* pierCalls).join("\n"), "commit -m");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lands the changeset it just committed and links the pull request to the thread", () =>
    Effect.gen(function* () {
      const { pier, run, pierCalls, dispatched } = yield* setup;
      yield* pier.setLanding(pullRequestLanding);
      const result = yield* run({ action: "commit_land", message: "Land it", threadId: THREAD_ID });

      const calls = yield* pierCalls;
      assert.isBelow(
        calls.indexOf("commit -m Land it --json"),
        calls.indexOf("land cs-committed --json"),
      );
      assert.equal(result.landing?.state, "pr_open");
      assert.equal(result.landing?.pullRequest?.url, PULL_REQUEST_URL);
      assert.deepEqual(yield* Ref.get(dispatched), [
        {
          type: "thread.pull-request.link",
          commandId: CommandId.make(`server:pier-landing-link:${THREAD_ID}:${PULL_REQUEST_URL}`),
          threadId: THREAD_ID,
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          url: PULL_REQUEST_URL,
          source: "created",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lands the pinned changeset as it is when nothing is uncommitted", () =>
    Effect.gen(function* () {
      const { run, setUncommitted, pierCalls } = yield* setup;
      yield* setUncommitted([]);
      const result = yield* run({ action: "commit_land" });

      assert.isNull(result.commit);
      assert.equal(result.landing?.state, "pending");
      assert.include(yield* pierCalls, "land cs-pinned --json");
      assert.notInclude((yield* pierCalls).join("\n"), "commit -m");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels the pinned changeset's landing, linking nothing", () =>
    Effect.gen(function* () {
      const { pier, run, pierCalls, dispatched } = yield* setup;
      yield* pier.setLanding({ ...pullRequestLanding, state: "cancelled" });
      const result = yield* run({ action: "cancel_land", threadId: THREAD_ID });

      assert.equal(result.landing?.state, "cancelled");
      assert.include(yield* pierCalls, "land cs-pinned --cancel --json");
      assert.deepEqual(yield* Ref.get(dispatched), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports the paths a rebase leaves conflicted, and pier's refusal", () =>
    Effect.gen(function* () {
      const { pier, run, refreshed, checkout } = yield* setup;
      yield* pier.setRebase({
        onto: "cs-main",
        git: "sha1:abc",
        head: "cs-rebased",
        rebased: [
          { from: "cs-one", to: "cs-one-new" },
          { from: "cs-pinned", to: "cs-rebased" },
        ],
        conflicts: ["src/a.ts", "src/b.ts"],
      });
      const result = yield* run({ action: "rebase" });
      assert.deepEqual(result.rebase, {
        rebased: 2,
        head: "cs-rebased",
        conflicts: ["src/a.ts", "src/b.ts"],
      });

      yield* pier.refuse("rebase", "the checkout has uncommitted edits");
      const error = yield* Effect.flip(run({ action: "rebase" }));
      assert.equal(error.detail, "the checkout has uncommitted edits");
      // A refused action still refreshes status, since pier may have done part of it.
      assert.deepEqual(yield* Ref.get(refreshed), [checkout, checkout]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("links a polled landing's pull request once, to the threads in that checkout", () =>
    Effect.gen(function* () {
      const { layer, checkout, dispatched } = yield* setup;
      const pullRequest = {
        number: 42,
        url: PULL_REQUEST_URL,
        approvals: 0,
        changesRequested: 0,
        checks: { pending: 1, passing: 0, failing: 0 },
      };
      const landing: PierLanding = {
        id: 9,
        tip: "cs-pinned",
        state: "pr_open",
        reasons: [],
        landed: null,
        pullRequest,
      };
      const remote = (pierLanding: PierLanding): VcsStatusRemoteResult => ({
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
        pier: {
          pinned: "cs-pinned",
          pinnedIsMain: false,
          mainRewritten: false,
          landing: pierLanding,
          serverError: null,
          conflicts: [],
        },
      });
      yield* Effect.gen(function* () {
        const actions = yield* PierActions.PierActions;
        yield* actions.linkPolledLanding(checkout, remote({ ...landing, pullRequest: null }));
        assert.deepEqual(yield* Ref.get(dispatched), []);

        yield* actions.linkPolledLanding(checkout, remote(landing));
        yield* actions.linkPolledLanding(
          checkout,
          remote({
            ...landing,
            pullRequest: { ...pullRequest, checks: { pending: 0, passing: 1, failing: 0 } },
          }),
        );
        yield* actions.linkPolledLanding("/elsewhere", remote(landing));
      }).pipe(Effect.provide(layer));

      const commands = yield* Ref.get(dispatched);
      assert.deepEqual(
        commands.map((command) => [command.type, "threadId" in command ? command.threadId : null]),
        [["thread.pull-request.link", THREAD_ID]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a link the orchestrator turned away, under a new command id", () =>
    Effect.gen(function* () {
      const { pier, layer, checkout, dispatched, rejections } = yield* setup;
      yield* pier.setLanding(pullRequestLanding);
      yield* Ref.set(rejections, 1);
      yield* Effect.gen(function* () {
        const actions = yield* PierActions.PierActions;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          yield* actions.run({ cwd: checkout, action: "land", threadId: THREAD_ID });
        }
      }).pipe(Effect.provide(layer));

      const base = `server:pier-landing-link:${THREAD_ID}:${PULL_REQUEST_URL}`;
      assert.deepEqual(
        (yield* Ref.get(dispatched)).map((command) => command.commandId),
        [CommandId.make(base), CommandId.make(`${base}:1`)],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
