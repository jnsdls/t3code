import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { VcsRepositoryDetectionError, VcsUnsupportedOperationError } from "@t3tools/contracts";

import * as GitVcsDriver from "../GitVcsDriver.ts";
import type * as VcsDriver from "../VcsDriver.ts";
import * as VcsProcess from "../VcsProcess.ts";

/**
 * Turn checkpoints for a pier checkout live in a git repository of their own
 * under the server's state folder, with the checkout as its work tree. pier
 * never sees them, so they cannot become changesets, and the checkout keeps
 * no `.git` for agents to trip over.
 */
export const pierCheckpointGitDir = Effect.fn("pierCheckpointGitDir")(function* (
  stateDir: string,
  checkoutRoot: string,
) {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const resolved = path.resolve(checkoutRoot);
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(resolved))
    .pipe(Effect.orDie);
  const name = `${path.basename(resolved)}-${Hex.encode(digest).slice(0, 16)}.git`;
  return path.join(stateDir, "pier-checkpoints", name);
});

export const removePierCheckpoints = Effect.fn("removePierCheckpoints")(function* (
  stateDir: string,
  checkoutRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const gitDir = yield* pierCheckpointGitDir(stateDir, checkoutRoot);
  yield* fileSystem.remove(gitDir, { recursive: true, force: true }).pipe(Effect.ignore);
});

type GitShape = Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>;

const CHECKPOINT_AUTHOR: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};
const SHADOW_GC_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the git driver's own checkpoint and file listing code against the
 * shadow repository, by pointing every git process it starts at it.
 */
export const makePierShadowGit = Effect.fn("makePierShadowGit")(function* (input: {
  /** Null when the server has no state folder to keep checkpoints in. */
  readonly stateDir: string | null;
  readonly findCheckoutRoot: (cwd: string) => Effect.Effect<string | null>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  const shapes = new Map<string, GitShape>();
  // A prune must not run while a capture has written objects nothing references yet.
  const writers = new Map<string, Semaphore.Semaphore>();

  const shadowFor = Effect.fn("PierShadowGit.shadowFor")(function* (
    operation: string,
    cwd: string,
    options: { readonly create: boolean },
  ) {
    if (input.stateDir === null) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: "pier",
        detail: "The server has no state folder for pier checkpoints.",
      });
    }
    const root = yield* input.findCheckoutRoot(cwd);
    if (root === null) {
      return yield* new VcsRepositoryDetectionError({
        operation,
        cwd,
        detail: "Not inside a pier checkout.",
      });
    }
    const gitDir = yield* pierCheckpointGitDir(input.stateDir, root).pipe(
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    const env = { GIT_DIR: gitDir, GIT_WORK_TREE: root };
    if (
      options.create &&
      !(yield* fileSystem.exists(path.join(gitDir, "HEAD")).pipe(Effect.orElseSucceed(() => false)))
    ) {
      const failed = (cause: unknown) =>
        new VcsRepositoryDetectionError({
          operation,
          cwd,
          detail: "Could not create the pier checkpoint repository.",
          cause,
        });
      // Written before `git init`, which keeps an existing file: the checkout's
      // `.gitignore` files apply as they do for pier, and its own metadata
      // never belongs in a checkpoint or a restore.
      yield* fileSystem
        .makeDirectory(path.join(gitDir, "info"), { recursive: true })
        .pipe(
          Effect.andThen(
            fileSystem.writeFileString(path.join(gitDir, "info", "exclude"), "/.pier/\n"),
          ),
          Effect.mapError(failed),
        );
      yield* vcsProcess.run({
        operation,
        command: "git",
        args: ["init", "--quiet"],
        cwd: root,
        env,
      });
    }
    let shape = shapes.get(gitDir);
    if (shape === undefined) {
      shape = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (processInput) =>
            vcsProcess.run(
              processInput.command !== "git" ||
                // The git driver clears GIT_DIR on purpose to look into nested repositories.
                (processInput.env !== undefined &&
                  "GIT_DIR" in processInput.env &&
                  processInput.env.GIT_DIR === undefined)
                ? processInput
                : { ...processInput, env: { ...processInput.env, ...env } },
            ),
        }),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      shapes.set(gitDir, shape);
    }
    let writer = writers.get(gitDir);
    if (writer === undefined) {
      writer = Semaphore.makeUnsafe(1);
      writers.set(gitDir, writer);
    }
    return { root, env, git: shape, writer };
  });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("PierShadowGit.captureCheckpoint")(function* (captureInput) {
      const operation = "PierShadowGit.captureCheckpoint";
      const shadow = yield* shadowFor(operation, captureInput.cwd, { create: true });
      yield* shadow.writer.withPermits(1)(
        Effect.gen(function* () {
          yield* shadow.git.checkpoints.captureCheckpoint(captureInput);
          const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
            vcsProcess
              .run({
                operation,
                command: "git",
                args,
                cwd: shadow.root,
                env: { ...shadow.env, ...env },
              })
              .pipe(Effect.map((output) => output.stdout.trim()));
          // The git driver parents a checkpoint on HEAD. Recommitted without a
          // parent, a checkpoint whose ref is deleted becomes unreachable.
          const tree = yield* git(["rev-parse", `${captureInput.checkpointRef}^{tree}`]);
          const commit = yield* git(
            ["commit-tree", tree, "-m", `t3 checkpoint ref=${captureInput.checkpointRef}`],
            CHECKPOINT_AUTHOR,
          );
          yield* git(["update-ref", captureInput.checkpointRef, commit]);
          // HEAD follows the latest checkpoint, with no reflog to keep the
          // earlier ones, and the shadow index keeps its file stats, so the
          // next capture rehashes only what changed since.
          yield* git([
            "-c",
            "core.logAllRefUpdates=false",
            "update-ref",
            "--no-deref",
            "HEAD",
            commit,
          ]).pipe(
            Effect.andThen(git(["-c", "core.fsmonitor=false", "add", "-A", "--", "."])),
            Effect.ignore,
          );
        }),
      );
    }),
    hasCheckpointRef: (refInput) =>
      shadowFor("PierShadowGit.hasCheckpointRef", refInput.cwd, { create: false }).pipe(
        Effect.flatMap((shadow) => shadow.git.checkpoints.hasCheckpointRef(refInput)),
      ),
    restoreCheckpoint: (restoreInput) =>
      shadowFor("PierShadowGit.restoreCheckpoint", restoreInput.cwd, { create: false }).pipe(
        // HEAD is the latest checkpoint here, not a commit of the user's.
        Effect.flatMap((shadow) =>
          shadow.git.checkpoints.restoreCheckpoint({ ...restoreInput, fallbackToHead: false }),
        ),
      ),
    diffCheckpoints: (diffInput) =>
      shadowFor("PierShadowGit.diffCheckpoints", diffInput.cwd, { create: false }).pipe(
        Effect.flatMap((shadow) =>
          shadow.git.checkpoints.diffCheckpoints({ ...diffInput, fallbackFromToHead: false }),
        ),
      ),
    // Checkpoints have no parents, so they record no commits the agent made.
    listAuthoredPaths: () => Effect.succeed(null),
    deleteCheckpointRefs: Effect.fn("PierShadowGit.deleteCheckpointRefs")(function* (deleteInput) {
      const operation = "PierShadowGit.deleteCheckpointRefs";
      const shadow = yield* shadowFor(operation, deleteInput.cwd, { create: false });
      yield* shadow.git.checkpoints.deleteCheckpointRefs(deleteInput);
      yield* shadow.writer.withPermits(1)(
        // Nothing else references a deleted checkpoint, so it can go now. Older
        // shadows still hold HEAD reflogs, which expire with it.
        vcsProcess
          .run({
            operation,
            command: "git",
            args: [
              "-c",
              "gc.reflogExpire=now",
              "-c",
              "gc.reflogExpireUnreachable=now",
              "gc",
              "--prune=now",
              "--quiet",
            ],
            cwd: shadow.root,
            env: shadow.env,
            timeoutMs: SHADOW_GC_TIMEOUT_MS,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not prune pier checkpoints", { cwd: shadow.root, cause }),
            ),
          ),
      );
    }),
  };

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    shadowFor("PierShadowGit.listWorkspaceFiles", cwd, { create: true }).pipe(
      Effect.flatMap((shadow) => shadow.git.listWorkspaceFiles(cwd)),
    );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = (
    cwd,
    relativePaths,
  ) =>
    shadowFor("PierShadowGit.filterIgnoredPaths", cwd, { create: true }).pipe(
      Effect.flatMap((shadow) => shadow.git.filterIgnoredPaths(cwd, relativePaths)),
    );

  return { checkpoints, listWorkspaceFiles, filterIgnoredPaths };
});
