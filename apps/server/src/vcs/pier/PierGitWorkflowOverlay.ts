import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { makeIsManagedWorktreePath } from "../../worktreesDirectory.ts";
import * as PierCli from "./PierCli.ts";
import { makePierThreadCheckouts } from "./pierThreadCheckout.ts";

/**
 * The Git workflow, with pier checkouts routed to pier. A pier checkout has
 * no `.git`, so the Git workflow alone would call it no repository.
 */
export const make = Effect.gen(function* () {
  const base = yield* GitWorkflowService.GitWorkflowService;
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

  return GitWorkflowService.GitWorkflowService.of({
    ...base,
    localStatus: (input) =>
      base.localStatus(input).pipe(
        Effect.filterOrElse(
          (status) => status.isRepo,
          (status) =>
            Effect.all([pier.isCheckout(input.cwd), pier.isAvailable]).pipe(
              Effect.map(([checkout, available]) =>
                checkout && available ? { ...status, pierCheckout: true } : status,
              ),
            ),
        ),
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
