import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import { useEffect } from "react";

import type { DraftThreadEnvMode } from "../../composerDraftStore";
import {
  recallPierCheckout,
  rememberPierCheckout,
  resolvePierRequestedEnvMode,
  resolvePierSendBlockReason,
} from "./pierComposer.logic";

/** The composer's pier decisions for the checkout whose status `status` holds. */
export function usePierComposer(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly status: { readonly data: VcsStatusResult | null; readonly error: string | null };
}) {
  const { environmentId, cwd, status } = input;
  const live = status.data === null ? undefined : status.data.pierCheckout === true;
  useEffect(() => {
    if (cwd !== null && live !== undefined) rememberPierCheckout(environmentId, cwd, live);
  }, [environmentId, cwd, live]);
  const pierCheckout = live ?? recallPierCheckout(environmentId, cwd) ?? null;
  const statusLoading = status.data === null && status.error === null;

  return {
    checkout: pierCheckout === true,
    requestedEnvMode: (envMode: DraftThreadEnvMode) =>
      resolvePierRequestedEnvMode(envMode, pierCheckout),
    sendBlockReason: (envMode: DraftThreadEnvMode) =>
      resolvePierSendBlockReason({
        requestedEnvMode: resolvePierRequestedEnvMode(envMode, pierCheckout),
        pierCheckout,
        statusLoading,
      }),
    /** Hides git's branch controls and offers pier checkouts in place of worktrees. */
    toolbarProps: pierCheckout === true ? { showGitControls: false, pierCheckout: true } : {},
  };
}
