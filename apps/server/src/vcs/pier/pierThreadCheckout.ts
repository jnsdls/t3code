import type { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import type * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import { removePierCheckpoints } from "./PierCheckpoints.ts";
import * as PierCli from "./PierCli.ts";

/** Stable per thread, so a retried launch names the same agent and folder. */
function pierAgentName(threadId: string): string {
  return `t3-${threadId
    .toLowerCase()
    .replace(/[^0-9a-z]/g, "")
    .slice(-8)}`;
}

/**
 * A thread's pier checkout sits where its git worktree would:
 * `<worktrees folder>/<repo>/<agent>`.
 */
export const makePierThreadCheckouts = Effect.gen(function* () {
  const pier = yield* PierCli.PierCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const create = Effect.fn("PierThreadCheckouts.create")(function* (input: {
    readonly projectRoot: string;
    readonly threadId: string;
    /** Runs before pier writes anything, so a failed checkout can still be removed. */
    readonly onClaimed: (directory: string) => Effect.Effect<void>;
  }) {
    const fail = (detail: string) =>
      new PierCli.PierCliError({ operation: "checkout", cwd: input.projectRoot, detail });
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => fail(cause.message)),
    );
    const parent = resolveWorktreesDirectory(
      settings.worktreesDirectory,
      serverConfig.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parent === null)
      return yield* fail(
        `The worktree location "${settings.worktreesDirectory}" must be an absolute folder on this machine, not a drive root.`,
      );
    const agent = pierAgentName(input.threadId);
    const directory = path.join(parent, path.basename(path.resolve(input.projectRoot)), agent);
    if (yield* fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => true)))
      return yield* fail(`${directory} already exists.`);
    yield* input.onClaimed(directory);
    yield* pier.checkoutLike({ source: input.projectRoot, directory, agent });
    return directory;
  });

  /** Lays out a launching thread's checkout as the worktree setup's checkout stage. */
  const provision = <E>(input: {
    readonly projectRoot: string;
    readonly threadId: ThreadId;
    readonly setup: WorktreeSetupTracker.WorktreeSetupTracker["Service"];
    /** Tells the run it is setting up its workspace. */
    readonly announce: Effect.Effect<void, E>;
    readonly onClaimed: (directory: string) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      yield* input.setup.begin({
        threadId: input.threadId,
        branch: null,
        baseRef: null,
        stages: ["checkout", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
      yield* input.announce;
      yield* input.setup.stageStatus(input.threadId, "checkout", "running");
      const worktreePath = yield* create(input);
      yield* input.setup.update(input.threadId, (snapshot) => ({ ...snapshot, worktreePath }));
      yield* input.setup.stageStatus(input.threadId, "checkout", "done");
      return worktreePath;
    });

  // The folder is named for the thread's agent, so the abandon spares a checkout pointed elsewhere.
  const remove = (directory: string) =>
    pier
      .removeCheckout(directory, { agent: path.basename(directory) })
      .pipe(
        Effect.andThen(removePierCheckpoints(serverConfig.stateDir, directory)),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
      );

  /** `git`'s worktree removal, which removes the thread's pier checkout when it has one. */
  const workspacesFor = <I extends { readonly path: string }, E>(
    strategy: { readonly type: string },
    git: { readonly removeWorktree: (input: I) => Effect.Effect<void, E> },
  ) => ({
    removeWorktree: (input: I): Effect.Effect<void, E | PierCli.PierCliError> =>
      strategy.type === "pier_checkout" ? remove(input.path) : git.removeWorktree(input),
  });

  return { provision, remove, workspacesFor };
});
