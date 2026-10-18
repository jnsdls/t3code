import {
  AuthSourceControlWriteScope,
  type PierAction,
  type PierLandingState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PIER_ACTION_PROGRESS_LABELS,
  buildPierMenuItems,
  describePierLanding,
  describePierServerState,
  resolvePierQuickAction,
  summarizePierActionResult,
  summarizePierPullRequest,
  type PierLandingTone,
} from "@t3tools/client-runtime/state/pier";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitCommitIcon,
  InfoIcon,
  RefreshCwIcon,
  UndoIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { pierEnvironment } from "~/state/pier";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { GIT_ACTION_SUCCESS_VISIBLE_MS } from "./GitActionsControl.logic";
import { PullRequestGlyph, type PullRequestGlyphIcon } from "./pullRequest/pullRequestIcons";

interface PierActionsControlProps {
  gitCwd: string;
  activeThreadRef: ScopedThreadRef;
  compact?: boolean;
  onOpenChanges?: () => void;
}

const ACTION_ICONS: Record<PierAction, typeof GitCommitIcon> = {
  commit: GitCommitIcon,
  land: PullRequestGlyph.merged,
  commit_land: PullRequestGlyph.merged,
  cancel_land: UndoIcon,
  rebase: RefreshCwIcon,
};

const LANDING_GLYPHS: Record<PierLandingState, PullRequestGlyphIcon> = {
  pending: PullRequestGlyph.draft,
  ready: PullRequestGlyph.draft,
  pushing: PullRequestGlyph.draft,
  pr_open: PullRequestGlyph.pullRequest,
  merging: PullRequestGlyph.pullRequest,
  landed: PullRequestGlyph.merged,
  flagged: PullRequestGlyph.conflicting,
  denied: PullRequestGlyph.conflicting,
  replaced: PullRequestGlyph.closed,
  cancelled: PullRequestGlyph.closed,
};

const TONE_CLASSES: Record<PierLandingTone, string> = {
  progress: "text-info-foreground",
  success: "text-success",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

/** The thread details panel's version-control section for a pier checkout, in place of git's. */
export default function PierActionsControl({
  gitCwd,
  activeThreadRef,
  compact = false,
  onOpenChanges,
}: PierActionsControlProps) {
  const environmentId = activeThreadRef.environmentId;
  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const serverThread = useQuietThreadShell(activeThreadRef);
  const openPrLink = useOpenPrLink(activeThreadRef);
  const runAction = useAtomCommand(pierEnvironment.runAction, { reportFailure: false });
  const { data: status, error: statusError } = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }),
  );
  const [running, setRunning] = useState<PierAction | null>(null);
  const [success, setSuccess] = useState<{ title: string; description: string | null } | null>(
    null,
  );
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  useEffect(() => {
    if (success === null) return;
    const timeoutId = window.setTimeout(() => setSuccess(null), GIT_ACTION_SUCCESS_VISIBLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [success]);

  const toastData = { threadRef: activeThreadRef };
  const quickAction = resolvePierQuickAction(status ?? null);
  const menuItems = buildPierMenuItems(status ?? null);
  const landing = status?.pier?.landing ?? null;
  const conflicts = status?.pier?.conflicts ?? [];
  const uncommittedCount = status?.workingTree.files.length ?? 0;
  const serverState = describePierServerState(status ?? null);

  async function run(action: PierAction, message?: string) {
    if (running !== null || !readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
      return;
    }
    setSuccess(null);
    setRunning(action);
    const result = await runAction({
      environmentId,
      input: {
        cwd: gitCwd,
        action,
        ...(message ? { message } : {}),
        ...(serverThread ? { threadId: serverThread.id } : {}),
      },
    });
    setRunning(null);
    if (result._tag === "Success") {
      setSuccess(summarizePierActionResult(result.value));
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "pier action failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: toastData,
      }),
    );
  }

  const runCommitDialog = (action: "commit" | "commit_land") => {
    const message = commitMessage.trim();
    setCommitDialogOpen(false);
    setCommitMessage("");
    void run(action, message);
  };

  const QuickIcon =
    quickAction.kind === "open_pr"
      ? PullRequestGlyph.pullRequest
      : quickAction.kind === "run"
        ? ACTION_ICONS[quickAction.action]
        : InfoIcon;
  const quickLabel = (
    <>
      <QuickIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{quickAction.label}</span>
    </>
  );

  const actionGroup = (
    <div
      role="group"
      aria-label="pier actions"
      className={cn(
        "shrink-0",
        THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
        running !== null && "bg-black/[0.035] dark:bg-white/[0.055]",
      )}
    >
      {running !== null ? (
        <ThreadDetailsControl part="primary" disabled size="xs" variant="ghost">
          <Spinner aria-hidden="true" className="-mx-0.5 shrink-0" />
          <span role="status" className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {PIER_ACTION_PROGRESS_LABELS[running]}
          </span>
        </ThreadDetailsControl>
      ) : success !== null ? (
        <ThreadDetailsControl part="primary" multiline disabled size="xs" variant="ghost">
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          <span role="status" className="flex min-w-0 flex-col">
            <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              {success.title}
            </span>
            {success.description ? (
              <span className="truncate pt-0.5 text-2xs font-normal text-muted-foreground">
                {success.description}
              </span>
            ) : null}
          </span>
        </ThreadDetailsControl>
      ) : quickAction.kind === "none" ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <ThreadDetailsControl aria-disabled="true" part="primary" size="xs" variant="ghost" />
            }
          >
            {quickLabel}
          </PopoverTrigger>
          <PopoverPopup tooltipStyle side="bottom" align="start">
            {quickAction.hint}
          </PopoverPopup>
        </Popover>
      ) : (
        <ThreadDetailsControl
          part="primary"
          size="xs"
          variant="ghost"
          disabled={quickAction.kind === "run" && !canWrite}
          onClick={(event) => {
            if (quickAction.kind === "open_pr") openPrLink(event, quickAction.url);
            else void run(quickAction.action);
          }}
        >
          {quickLabel}
        </ThreadDetailsControl>
      )}
      <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              aria-label="pier action options"
              size="sm"
              variant="ghost"
              part="secondary"
            />
          }
          disabled={running !== null}
        >
          <ChevronDownIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end" className="w-64">
          {menuItems.map((item) => {
            const Icon = ACTION_ICONS[item.action];
            return (
              <div key={item.action}>
                <MenuItem
                  disabled={!canWrite || item.disabledReason !== null}
                  onClick={() => {
                    if (item.action === "commit" || item.action === "commit_land") {
                      setCommitDialogOpen(true);
                    } else {
                      void run(item.action);
                    }
                  }}
                >
                  <Icon />
                  <MenuItemLabel>{item.label}</MenuItemLabel>
                </MenuItem>
                {item.disabledReason ? (
                  <p className="px-2 pb-1.5 text-xs text-muted-foreground">{item.disabledReason}</p>
                ) : null}
              </div>
            );
          })}
          {statusError ? (
            <p className="px-2 py-1.5 text-xs text-destructive">{statusError}</p>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );

  const pullRequest = landing?.pullRequest ?? null;
  const landingDescription = landing ? describePierLanding(landing) : null;
  const LandingIcon = landing ? LANDING_GLYPHS[landing.state] : PullRequestGlyph.pullRequest;
  const pullRequestSummary = pullRequest ? summarizePierPullRequest(pullRequest) : null;

  return (
    <>
      {compact && running === null && success === null ? null : actionGroup}
      {serverState ? (
        <p className="truncate px-2.5 pb-1 text-xs text-warning">{serverState}</p>
      ) : null}

      {landing && landingDescription ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          part="row"
          multiline
          disabled={!pullRequest}
          onClick={(event) => {
            if (pullRequest) openPrLink(event, pullRequest.url);
          }}
        >
          <LandingIcon
            aria-hidden
            className={cn("size-4 shrink-0", TONE_CLASSES[landingDescription.tone])}
          />
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              {landingDescription.label}
              {pullRequest ? ` · #${pullRequest.number}` : ""}
            </span>
            {pullRequestSummary ? (
              <span className="truncate pt-0.5 text-2xs font-normal text-muted-foreground">
                {pullRequestSummary}
              </span>
            ) : null}
          </span>
          {pullRequest ? <ExternalLinkIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} /> : null}
        </ThreadDetailsControl>
      ) : null}
      {landing && landing.reasons.length > 0 ? (
        <ul className="px-2.5 pb-1 text-xs text-warning">
          {landing.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {conflicts.length > 0 ? (
        <div className="px-2.5 pb-1 text-xs text-warning">
          <p>Conflicted: settle each by editing it or with `pier resolve`, then commit.</p>
          <ul className="font-mono">
            {conflicts.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ThreadDetailsControl
        type="button"
        variant="ghost"
        size="sm"
        part="row"
        disabled={!onOpenChanges}
        onClick={onOpenChanges}
      >
        <FileDiffIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Changes</span>
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">
          {uncommittedCount} uncommitted
        </span>
      </ThreadDetailsControl>

      <Dialog
        open={commitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCommitDialogOpen(false);
            setCommitMessage("");
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Commit edits</DialogTitle>
            <DialogDescription>
              pier commits every uncommitted edit in the checkout. Leave the message blank to
              generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-1">
              <p className="text-sm font-medium">Commit message (optional)</p>
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Leave empty to auto-generate"
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" size="sm" onClick={() => setCommitDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite}
              onClick={() => runCommitDialog("commit")}
            >
              Commit
            </Button>
            <Button size="sm" disabled={!canWrite} onClick={() => runCommitDialog("commit_land")}>
              Commit & land
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
