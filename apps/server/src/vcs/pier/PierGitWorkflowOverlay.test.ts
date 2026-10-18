import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { makeFakePier, writePierCheckoutMarker } from "../testing/FakePier.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import * as VcsProcess from "../VcsProcess.ts";
import { pierCheckpointGitDir } from "./PierCheckpoints.ts";
import * as PierGitWorkflowOverlay from "./PierGitWorkflowOverlay.ts";

// Removal checks whether a path is a pier checkout under the managed worktrees folder.
const layerWorktreeLocation = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-" }),
  ServerSettings.ServerSettingsService.layerTest(),
).pipe(Layer.provideMerge(NodeServices.layer));

const layerWithPier = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly removeWorktree?: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"];
}) =>
  PierGitWorkflowOverlay.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: () => Effect.succeed(null),
        resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        removeWorktree: input.removeWorktree ?? (() => Effect.void),
      }),
    ),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(Layer.succeed(HostProcess.Environment, input.environment)),
    Layer.provideMerge(layerWorktreeLocation),
  );

describe("PierGitWorkflowOverlay", () => {
  it.effect("deletes a thread's pier checkout and its checkpoints instead of asking git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pier = yield* makeFakePier;
      const removeWorktree = vi.fn(() => Effect.void);
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const checkout = `${config.worktreesDir}/widgets/t3-0123abcd`;
        yield* writePierCheckoutMarker(checkout);
        const checkpoints = yield* pierCheckpointGitDir(config.stateDir, checkout);
        yield* fileSystem.makeDirectory(checkpoints, { recursive: true });
        yield* pier.setStatus({
          root: checkout,
          server: "http://pier.test",
          upstream: "acme/widgets",
          pinned: "cs-pinned",
          agent: "t3-0123abcd",
          cone: ["src"],
          uncommitted: [],
        });
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.removeWorktree({ cwd: "/projects/widgets", path: checkout, force: true });

        assert.isFalse(yield* fileSystem.exists(checkout));
        assert.isFalse(yield* fileSystem.exists(checkpoints));
        // `pier abandon` takes no `--json`.
        assert.match((yield* pier.calls).at(-1) ?? "", /\|abandon cs-pinned$/u);
        expect(removeWorktree).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layerWithPier({ environment: pier.environment, removeWorktree })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("abandons nothing while the changeset's landing is under way or unknown", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pier = yield* makeFakePier;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        for (const [index, server] of [
          {
            landing: { id: 7, tip: "cs-pinned", state: "merging", landed: null },
            landing_error: null,
          },
          { landing: null, landing_error: "not logged in: run `pier login`" },
        ].entries()) {
          const checkout = `${config.worktreesDir}/widgets-${index}/t3-0123abcd`;
          yield* writePierCheckoutMarker(checkout);
          yield* pier.setStatus({
            root: checkout,
            server: "http://pier.test",
            upstream: "acme/widgets",
            pinned: "cs-pinned",
            agent: "t3-0123abcd",
            cone: ["src"],
            uncommitted: [],
            ...server,
          });
          yield* workflow.removeWorktree({ cwd: "/projects/widgets", path: checkout, force: true });
          assert.isFalse(yield* fileSystem.exists(checkout));
        }
        assert.isFalse((yield* pier.calls).some((call) => call.includes("|abandon")));
      }).pipe(Effect.provide(layerWithPier({ environment: pier.environment })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("abandons nothing for a checkout another agent owns", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pier = yield* makeFakePier;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const checkout = `${config.worktreesDir}/widgets/t3-0123abcd`;
        yield* writePierCheckoutMarker(checkout);
        yield* pier.setStatus({
          root: checkout,
          server: null,
          upstream: "acme/widgets",
          pinned: "cs-pinned",
          agent: "someone-else",
          cone: ["src"],
          uncommitted: [],
        });
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.removeWorktree({ cwd: "/projects/widgets", path: checkout, force: true });

        assert.isFalse(yield* fileSystem.exists(checkout));
        assert.isFalse((yield* pier.calls).some((call) => call.includes("|abandon")));
      }).pipe(Effect.provide(layerWithPier({ environment: pier.environment })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a pier checkout outside the worktrees folder to git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pier = yield* makeFakePier;
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pier-own-" });
      yield* writePierCheckoutMarker(checkout);
      const removeWorktree = vi.fn(() => Effect.void);
      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.removeWorktree({ cwd: "/projects/widgets", path: checkout, force: true });
      }).pipe(Effect.provide(layerWithPier({ environment: pier.environment, removeWorktree })));

      assert.isTrue(yield* fileSystem.exists(checkout));
      expect(removeWorktree).toHaveBeenCalledOnce();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a pier checkout's status from pier, and fails plainly without it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pier = yield* makeFakePier;
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pier-own-" });
      yield* writePierCheckoutMarker(checkout);
      yield* pier.setStatus({
        root: checkout,
        server: "http://pier.test",
        upstream: "acme/widgets",
        pinned: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        agent: "t3-0123abcd",
        cone: ["src"],
        main: { branch: "main", base: { state: "behind", base: "sha1:aa", commits: 3 } },
        main_error: null,
        landing: null,
        landing_error: null,
        conflicts: [],
        conflicts_error: null,
        resolved: [{ path: "src/c.ts", took: "main" }],
        uncommitted: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/b.ts", status: "added" },
        ],
      });
      const status = (environment: NodeJS.ProcessEnv) =>
        GitWorkflowService.GitWorkflowService.pipe(
          Effect.flatMap((workflow) => workflow.status({ cwd: checkout })),
          Effect.provide(
            PierGitWorkflowOverlay.layer.pipe(
              Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
              Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
              Layer.provide(Layer.mock(GitManager.GitManager)({})),
              Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
              Layer.provideMerge(layerWorktreeLocation),
            ),
          ),
        );

      const withPier = yield* status(pier.environment);
      assert.isTrue(withPier.isRepo);
      assert.isTrue(withPier.pierCheckout);
      assert.equal(withPier.refName, "t3-0123abcd");
      // A resolved conflict is committed with the edits, even with its file untouched.
      assert.deepEqual(
        withPier.workingTree.files.map((file) => file.path),
        ["src/a.ts", "src/b.ts", "src/c.ts"],
      );
      assert.isTrue(withPier.hasWorkingTreeChanges);
      assert.equal(withPier.behindCount, 3);
      assert.isFalse(withPier.hasUpstream);
      assert.isFalse(withPier.hasPrimaryRemote);

      // The checkout is still pier's, so git never answers for an enclosing repository.
      const withoutPier = yield* Effect.flip(status({ ...pier.environment, PATH: "" }));
      assert.include(withoutPier.message, "pier isn't on the server's PATH");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
