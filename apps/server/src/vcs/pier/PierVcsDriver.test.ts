import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import * as ServerConfig from "../../config.ts";
import { makeFakePier, writePierCheckoutMarker } from "../testing/FakePier.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import * as VcsProcess from "../VcsProcess.ts";
import { pierCheckpointGitDir } from "./PierCheckpoints.ts";

const layerFor = (environment: NodeJS.ProcessEnv) =>
  CheckpointStore.layer.pipe(
    Layer.provideMerge(VcsDriverRegistry.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pier-driver-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/** A pier checkout of a few files with a `.gitignore`, and a fake `pier` that serves it. */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pier = yield* makeFakePier;
  const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pier-checkout-" });
  yield* writePierCheckoutMarker(checkout);
  const write = (relativePath: string, contents: string) =>
    fileSystem
      .makeDirectory(path.dirname(path.join(checkout, relativePath)), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(path.join(checkout, relativePath), contents)),
      );
  yield* write(".gitignore", "build/\n");
  yield* write("src/a.ts", "export const a = 1;\n");
  yield* write("src/b.ts", "export const b = 1;\n");
  yield* write("build/out.js", "generated\n");
  return { pier, checkout, write, path, fileSystem };
});

describe("PierVcsDriver", () => {
  it.effect("detects a pier checkout from inside it, with or without pier to run", () =>
    Effect.gen(function* () {
      const { pier, checkout, path } = yield* setup;
      const detect = (environment: NodeJS.ProcessEnv) =>
        VcsDriverRegistry.VcsDriverRegistry.pipe(
          Effect.flatMap((registry) => registry.detect({ cwd: path.join(checkout, "src") })),
          Effect.provide(layerFor(environment)),
        );

      const detected = yield* detect(pier.environment);
      assert.equal(detected?.kind, "pier");
      assert.equal(detected?.repository.rootPath, checkout);
      assert.isFalse(detected?.driver.capabilities.supportsWorktrees);
      assert.equal((yield* detect({ ...pier.environment, PATH: "" }))?.kind, "pier");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("captures, diffs and restores checkpoints outside the checkout", () =>
    Effect.gen(function* () {
      const { pier, checkout, write, path, fileSystem } = yield* setup;
      yield* Effect.gen(function* () {
        const store = yield* CheckpointStore.CheckpointStore;
        const config = yield* ServerConfig.ServerConfig;
        const threadId = ThreadId.make("thread-pier");
        const first = checkpointRefForThreadTurn(threadId, 0);
        const second = checkpointRefForThreadTurn(threadId, 1);

        assert.isTrue(yield* store.isGitRepository(checkout));
        yield* store.captureCheckpoint({ cwd: checkout, checkpointRef: first });
        yield* write("src/a.ts", "export const a = 2;\n");
        yield* write("src/c.ts", "export const c = 1;\n");
        yield* fileSystem.remove(path.join(checkout, "src/b.ts"));
        yield* write("build/out.js", "regenerated\n");
        yield* write(".pier/checkout.json", '{"pinned":"next"}');
        yield* store.captureCheckpoint({ cwd: checkout, checkpointRef: second });

        const numstat = yield* store.diffCheckpoints({
          cwd: checkout,
          fromCheckpointRef: first,
          toCheckpointRef: second,
          ignoreWhitespace: false,
          format: "numstat",
        });
        assert.deepEqual(
          parseTurnDiffFilesFromNumstat(numstat).map((file) => file.path),
          ["src/a.ts", "src/b.ts", "src/c.ts"],
        );
        assert.isNull(
          yield* store.listAuthoredPaths({
            cwd: checkout,
            fromCheckpointRef: first,
            toCheckpointRef: second,
          }),
        );

        assert.isTrue(yield* store.restoreCheckpoint({ cwd: checkout, checkpointRef: first }));
        const read = (relativePath: string) =>
          fileSystem.readFileString(path.join(checkout, relativePath));
        assert.equal(yield* read("src/a.ts"), "export const a = 1;\n");
        assert.equal(yield* read("src/b.ts"), "export const b = 1;\n");
        assert.isFalse(yield* fileSystem.exists(path.join(checkout, "src/c.ts")));
        // Ignored files and pier's own state are left as they are.
        assert.equal(yield* read("build/out.js"), "regenerated\n");
        assert.equal(yield* read(".pier/checkout.json"), '{"pinned":"next"}');
        assert.isFalse(yield* fileSystem.exists(path.join(checkout, ".git")));

        const gitDir = yield* pierCheckpointGitDir(config.stateDir, checkout);
        assert.isTrue(yield* fileSystem.exists(path.join(gitDir, "HEAD")));
        // pier was never asked to record anything.
        assert.deepEqual(yield* pier.calls, []);
      }).pipe(Effect.provide(layerFor(pier.environment)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets go of a deleted checkpoint so git can prune it", () =>
    Effect.gen(function* () {
      const { pier, checkout, write } = yield* setup;
      yield* Effect.gen(function* () {
        const store = yield* CheckpointStore.CheckpointStore;
        const config = yield* ServerConfig.ServerConfig;
        const vcsProcess = yield* VcsProcess.VcsProcess;
        const gitDir = yield* pierCheckpointGitDir(config.stateDir, checkout);
        const git = (args: ReadonlyArray<string>) =>
          vcsProcess.run({
            operation: "test",
            command: "git",
            args,
            cwd: checkout,
            env: { GIT_DIR: gitDir, GIT_WORK_TREE: checkout },
            allowNonZeroExit: true,
          });
        const threadId = ThreadId.make("thread-pier-prune");
        const refs = [0, 1, 2].map((turn) => checkpointRefForThreadTurn(threadId, turn));
        const commits: string[] = [];
        for (const [turn, ref] of refs.entries()) {
          yield* write("src/a.ts", `export const a = ${turn + 10};\n`);
          yield* store.captureCheckpoint({ cwd: checkout, checkpointRef: ref });
          commits.push((yield* git(["rev-parse", ref])).stdout.trim());
        }
        // No checkpoint keeps another reachable.
        assert.equal((yield* git(["rev-list", "--count", refs[2]!])).stdout.trim(), "1");

        yield* store.deleteCheckpointRefs({ cwd: checkout, checkpointRefs: [refs[0]!, refs[1]!] });
        assert.notEqual((yield* git(["cat-file", "-e", commits[0]!])).exitCode, 0);
        assert.notEqual((yield* git(["cat-file", "-e", commits[1]!])).exitCode, 0);
        assert.equal((yield* git(["cat-file", "-e", commits[2]!])).exitCode, 0);
        assert.isTrue(yield* store.restoreCheckpoint({ cwd: checkout, checkpointRef: refs[2]! }));
      }).pipe(Effect.provide(layerFor(pier.environment)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists workspace files the way pier sees them", () =>
    Effect.gen(function* () {
      const { pier, checkout } = yield* setup;
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const { driver } = yield* registry.resolve({ cwd: checkout });
        const listed = yield* driver.listWorkspaceFiles(checkout);
        assert.deepEqual(listed.paths.toSorted(), [".gitignore", "src/a.ts", "src/b.ts"]);
        assert.deepEqual(yield* driver.filterIgnoredPaths(checkout, ["src/a.ts", "build/out.js"]), [
          "src/a.ts",
        ]);
      }).pipe(Effect.provide(layerFor(pier.environment)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("previews uncommitted edits and the changes since main from pier diff", () =>
    Effect.gen(function* () {
      const { pier, checkout } = yield* setup;
      const patch = (file: string, from: string, to: string) =>
        [
          `diff --git a/${file} b/${file}`,
          "index 1111111..2222222 100644",
          `--- a/${file}`,
          `+++ b/${file}`,
          "@@ -1 +1 @@",
          `-${from}`,
          `+${to}`,
          "",
        ].join("\n");
      yield* pier.setDiff("cs-pinned", patch("src/a.ts", "a = 1", "a = 2"));
      yield* pier.setDiff(
        "merge-base",
        `${patch("src/a.ts", "a = 0", "a = 2")}${patch("src/b.ts", "b = 0", "b = 1")}`,
      );
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const { driver } = yield* registry.resolve({ cwd: checkout });
        const preview = yield* driver.getDiffPreview!({ cwd: checkout });
        const [uncommitted, branch] = preview.sources;
        assert.equal(uncommitted?.kind, "working-tree");
        assert.deepEqual(uncommitted?.files, [
          { path: "src/a.ts", previousPath: null, additions: 1, deletions: 1 },
        ]);
        assert.equal(branch?.kind, "branch-range");
        assert.deepEqual(
          branch?.files?.map((file) => file.path),
          ["src/a.ts", "src/b.ts"],
        );
        assert.include(branch?.diff ?? "", "+b = 1");

        const single = yield* driver.getDiffPreview!({
          cwd: checkout,
          file: { path: "src/b.ts", previousPath: null, sourceKind: "branch-range" },
        });
        assert.notInclude(single.sources[1]?.diff ?? "", "src/a.ts");
        assert.include(single.sources[1]?.diff ?? "", "+b = 1");
      }).pipe(Effect.provide(layerFor(pier.environment)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads local status without the server, and the landing from a full status", () =>
    Effect.gen(function* () {
      const { pier, checkout } = yield* setup;
      yield* pier.setStatus({
        root: checkout,
        server: "http://pier.test",
        upstream: "acme/widgets",
        pinned: "cs-pinned",
        agent: "t3-0123abcd",
        cone: ["src"],
        main: { branch: "main", base: { state: "behind", base: "sha1:aa", commits: 2 } },
        main_error: null,
        // An older changeset on main: not the tip, yet nothing of the checkout's own.
        on_main: true,
        on_main_error: null,
        landing: {
          id: 4,
          tip: "cs-pinned",
          state: "flagged",
          reasons: ["checks failed"],
          landed: null,
          pull_request: {
            number: 42,
            url: "https://github.com/acme/widgets/pull/42",
            reviews: [
              { login: "ana", state: "changes_requested", body: "", url: "" },
              { login: "ana", state: "approved", body: "", url: "" },
              { login: "bo", state: "commented", body: "", url: "" },
            ],
            comments: [],
            checks: [
              { name: "test", conclusion: "failure", url: "" },
              { name: "lint", conclusion: "success", url: "" },
            ],
          },
        },
        landing_error: null,
        conflicts: [{ path: "src/a.ts", kind: "text", base: null, main: null, changeset: null }],
        conflicts_error: null,
        resolved: [],
        uncommitted: [{ path: "src/a.ts", status: "modified" }],
      });
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const { driver } = yield* registry.resolve({ cwd: checkout });

        const local = yield* driver.localStatus!(checkout);
        assert.equal(local.refName, "t3-0123abcd");
        assert.include((yield* pier.calls).at(-1), "|status --local --json");

        const remote = yield* driver.remoteStatus!(checkout);
        assert.include((yield* pier.calls).at(-1), "|status --json");
        assert.equal(remote?.behindCount, 2);
        assert.deepEqual(remote?.pier, {
          pinned: "cs-pinned",
          pinnedIsMain: true,
          landing: {
            id: 4,
            tip: "cs-pinned",
            state: "flagged",
            reasons: ["checks failed"],
            landed: null,
            pullRequest: {
              number: 42,
              url: "https://github.com/acme/widgets/pull/42",
              approvals: 1,
              changesRequested: 0,
              checks: { pending: 0, passing: 1, failing: 1 },
            },
          },
          mainRewritten: false,
          serverError: null,
          conflicts: ["src/a.ts"],
        });
      }).pipe(Effect.provide(layerFor(pier.environment)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reports what the server could not answer, a rewritten main, and settled conflicts",
    () =>
      Effect.gen(function* () {
        const { pier, checkout } = yield* setup;
        const base = {
          root: checkout,
          server: "http://pier.test",
          upstream: "acme/widgets",
          pinned: "cs-pinned",
          agent: "t3-0123abcd",
          cone: ["src"],
          uncommitted: [],
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const { driver } = yield* registry.resolve({ cwd: checkout });

          // An expired login answers nothing, and the checkout must not look settled.
          yield* pier.setStatus({
            ...base,
            main: null,
            main_error: "not logged in: run `pier login`",
            on_main: null,
            on_main_error: "not logged in: run `pier login`",
            landing: null,
            landing_error: "not logged in: run `pier login`",
            conflicts: null,
            conflicts_error: "not logged in: run `pier login`",
            resolved: [],
          });
          const offline = yield* driver.remoteStatus!(checkout);
          assert.equal(offline?.pier?.serverError, "not logged in: run `pier login`");

          yield* pier.setStatus({
            ...base,
            main: { branch: "main", base: { state: "unreachable", base: "sha1:aa" } },
            main_error: null,
            on_main: false,
            on_main_error: null,
            landing: null,
            landing_error: null,
            conflicts: [
              { path: "src/a.ts", kind: "text", base: null, main: null, changeset: null },
              { path: "src/b.ts", kind: "text", base: null, main: null, changeset: null },
            ],
            conflicts_error: null,
            resolved: [{ path: "src/a.ts", took: "main" }],
          });
          const rewritten = yield* driver.remoteStatus!(checkout);
          assert.equal(rewritten?.behindCount, 0);
          assert.isTrue(rewritten?.pier?.mainRewritten);
          assert.isNull(rewritten?.pier?.serverError);
          assert.deepEqual(rewritten?.pier?.conflicts, ["src/b.ts"]);
        }).pipe(Effect.provide(layerFor(pier.environment)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
