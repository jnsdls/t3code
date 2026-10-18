import type { EnvironmentId } from "@t3tools/contracts";

import type { DraftThreadEnvMode } from "../../composerDraftStore";

/**
 * Whether the composer's checkout is a pier checkout: null until its status
 * first arrives. Remembered per checkout for the session, so a revisit knows
 * at once, as the Git flag is.
 */
export type PierCheckoutState = boolean | null;

const sessionPierCheckouts = new Map<string, boolean>();

const pierCheckoutKey = (environmentId: EnvironmentId, cwd: string) =>
  JSON.stringify([environmentId, cwd]);

export function rememberPierCheckout(
  environmentId: EnvironmentId,
  cwd: string,
  pierCheckout: boolean,
): void {
  sessionPierCheckouts.set(pierCheckoutKey(environmentId, cwd), pierCheckout);
}

export function recallPierCheckout(
  environmentId: EnvironmentId,
  cwd: string | null,
): boolean | undefined {
  return cwd === null ? undefined : sessionPierCheckouts.get(pierCheckoutKey(environmentId, cwd));
}

/**
 * The mode a send asks for. In a pier checkout a new workspace is a pier
 * checkout, never a git worktree; elsewhere a remembered pier choice falls
 * back to a worktree. While the status is unknown a pier choice stands, so
 * the send waits for the status or the server refuses it, and never lands
 * in the project's own checkout.
 */
export function resolvePierRequestedEnvMode(
  requestedEnvMode: DraftThreadEnvMode,
  pierCheckout: PierCheckoutState,
): DraftThreadEnvMode {
  if (requestedEnvMode === "local") return "local";
  if (pierCheckout === true) return "pier";
  if (pierCheckout === false && requestedEnvMode === "pier") return "worktree";
  return requestedEnvMode;
}

/** Holds a pier send until the status says whether the checkout is one. */
export function resolvePierSendBlockReason(input: {
  readonly requestedEnvMode: DraftThreadEnvMode;
  readonly pierCheckout: PierCheckoutState;
  readonly statusLoading: boolean;
}): string | null {
  return input.requestedEnvMode === "pier" && input.pierCheckout === null && input.statusLoading
    ? "Reading the checkout's status"
    : null;
}
