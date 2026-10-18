import {
  GitCommandError,
  GitManagerError,
  type GitManagerServiceError,
  type VcsError,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { makeIsManagedWorktreePath } from "../../worktreesDirectory.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import * as PierCli from "./PierCli.ts";
import { makePierThreadCheckouts } from "./pierThreadCheckout.ts";

/**
 * The Git workflow, with pier checkouts routed to pier: their status comes
 * from the pier driver, and a thread's own checkout is deleted rather than
 * removed as a worktree.
 */
export const make = Effect.gen(function* () {
  const base = yield* GitWorkflowService.GitWorkflowService;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const pier = yield* PierCli.PierCli;
  const pierCheckouts = yield* makePierThreadCheckouts;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  // A thread's own checkout is removed by deleting it.
  const isThreadPierCheckout = (path: string) =>
    pier
      .isCheckout(path)
      .pipe(
        Effect.flatMap((checkout) =>
          checkout ? isManagedWorktreePath(path) : Effect.succeed(false),
        ),
      );

  // A pier checkout reports status through its own driver.
  const driverStatus = <A>(
    operation: string,
    cwd: string,
    read: (
      driver: VcsDriverRegistry.VcsDriverHandle["driver"],
    ) => Effect.Effect<A, VcsError> | undefined,
    otherwise: Effect.Effect<A, GitManagerServiceError>,
  ) =>
    registry.detect({ cwd }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((handle) => {
        const status = handle === null ? undefined : read(handle.driver);
        return status === undefined
          ? otherwise
          : status.pipe(
              Effect.mapError(
                (cause) => new GitManagerError({ operation, cwd, detail: cause.message, cause }),
              ),
            );
      }),
    );

  return GitWorkflowService.GitWorkflowService.of({
    ...base,
    status: (input) =>
      driverStatus(
        "GitWorkflowService.status",
        input.cwd,
        ({ localStatus, remoteStatus }) =>
          localStatus && remoteStatus
            ? Effect.zipWith(localStatus(input.cwd), remoteStatus(input.cwd), mergeGitStatusParts)
            : undefined,
        base.status(input),
      ),
    localStatus: (input) =>
      driverStatus(
        "GitWorkflowService.localStatus",
        input.cwd,
        (driver) => driver.localStatus?.(input.cwd),
        base.localStatus(input),
      ),
    remoteStatus: (input, options) =>
      driverStatus(
        "GitWorkflowService.remoteStatus",
        input.cwd,
        (driver) => driver.remoteStatus?.(input.cwd),
        base.remoteStatus(input, options),
      ),
    removeWorktree: (input) =>
      isThreadPierCheckout(input.path).pipe(
        Effect.flatMap((pierCheckout) =>
          pierCheckout
            ? pierCheckouts.remove(input.path).pipe(
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      operation: "GitWorkflowService.removeWorktree",
                      command: "pier",
                      cwd: input.cwd,
                      detail: cause.message,
                      cause,
                    }),
                ),
              )
            : base.removeWorktree(input),
        ),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService.GitWorkflowService, make).pipe(
  Layer.provide(GitWorkflowService.layer),
  Layer.provide(PierCli.layer),
);
