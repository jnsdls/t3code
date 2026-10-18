import { EnvironmentId, ThreadId, type PierAction, type VcsStatusResult } from "@t3tools/contracts";
import {
  PIER_ACTION_PROGRESS_LABELS,
  resolvePierQuickAction,
  summarizePierActionResult,
} from "@t3tools/client-runtime/state/pier";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { pierEnvironment } from "../../state/pier";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";

/** The pier checkout's quick action in the thread's Git menu: commit and land, rebase, or view the PR. */
export function usePierQuickAction(input: {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly gitStatus: VcsStatusResult | null;
  readonly canWrite: boolean;
}) {
  const runAction = useAtomCommand(pierEnvironment.runAction, { reportFailure: false });
  const openPullRequest = useOpenPullRequest();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [running, setRunning] = useState<PierAction | null>(null);
  const resolved = resolvePierQuickAction(input.gitStatus);

  const { canWrite } = input;
  const quickAction =
    running !== null
      ? { label: PIER_ACTION_PROGRESS_LABELS[running], disabled: true, hint: null }
      : resolved.kind === "none"
        ? { label: resolved.label, disabled: true, hint: resolved.hint }
        : resolved.kind === "run" && !canWrite
          ? {
              label: resolved.label,
              disabled: true,
              hint: "This connection cannot change source control.",
            }
          : { label: resolved.label, disabled: false, hint: null };

  const { environmentId, threadId } = input;
  const run = async () => {
    if (resolved.kind === "open_pr") {
      if (!(await openPullRequest(resolved.url))) {
        Dialog.alert("Unable to open PR", "The pull request could not be opened.");
      }
      return;
    }
    if (resolved.kind !== "run" || selectedThreadCwd === null || running !== null) return;
    setRunning(resolved.action);
    const result = await runAction({
      environmentId: EnvironmentId.make(String(environmentId)),
      input: {
        cwd: selectedThreadCwd,
        action: resolved.action,
        threadId: ThreadId.make(String(threadId)),
      },
    });
    setRunning(null);
    if (result._tag === "Success") {
      const summary = summarizePierActionResult(result.value);
      Dialog.alert(summary.title, summary.description ?? undefined);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert("pier action failed", error instanceof Error ? error.message : undefined);
    }
  };

  return { quickAction, run };
}
