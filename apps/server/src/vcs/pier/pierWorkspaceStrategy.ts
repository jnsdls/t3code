/** Whether a launch gives the thread a workspace of its own: a git worktree or a pier checkout. */
export const isTrackedWorkspaceStrategy = (type: string | undefined) =>
  type === "worktree" || type === "pier_checkout";

/** A retried launch runs in the pier checkout its first attempt made, if it got that far. */
export const reusePierCheckout = (
  strategy: { readonly type: string },
  worktreePath: string | null,
) =>
  strategy.type === "pier_checkout" && worktreePath !== null
    ? {
        strategy: { type: "existing_worktree" as const, worktreePath },
        reusedWorktree: { baseRef: null },
      }
    : null;
