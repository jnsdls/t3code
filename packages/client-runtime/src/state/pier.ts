import {
  PIER_OPEN_LANDING_STATES,
  type PierAction,
  type PierLanding,
  type PierLandingPullRequest,
  type PierLandingState,
  type PierRunActionResult,
  type VcsStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createPierEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pier:run-action",
      tag: WS_METHODS.pierRunAction,
      // Serial with git status refreshes and other actions on the same checkout.
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}

// pier refuses to cancel once the push or merge is in flight.
const CANCELLABLE_STATES: ReadonlySet<PierLandingState> = new Set(["pending", "ready", "pr_open"]);

export const isPierLandingOpen = (landing: PierLanding | null | undefined) =>
  landing != null && PIER_OPEN_LANDING_STATES.has(landing.state);

export const isPierLandingCancellable = (landing: PierLanding | null | undefined) =>
  landing != null && CANCELLABLE_STATES.has(landing.state);

export type PierLandingTone = "progress" | "success" | "warning" | "muted";

const LANDING_STATES: Record<PierLandingState, { label: string; tone: PierLandingTone }> = {
  pending: { label: "Landing requested", tone: "progress" },
  ready: { label: "Ready to land", tone: "progress" },
  pushing: { label: "Pushing", tone: "progress" },
  pr_open: { label: "PR open", tone: "progress" },
  merging: { label: "Merging", tone: "progress" },
  landed: { label: "Landed", tone: "success" },
  flagged: { label: "Flagged", tone: "warning" },
  denied: { label: "Denied", tone: "warning" },
  replaced: { label: "Replaced", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const describePierLanding = (landing: PierLanding) => LANDING_STATES[landing.state];

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Reviews and checks in one line, such as "1 approval · 1 failing check". */
export function summarizePierPullRequest(pullRequest: PierLandingPullRequest): string | null {
  const { checks } = pullRequest;
  const parts = [
    pullRequest.changesRequested > 0
      ? plural(pullRequest.changesRequested, "change request")
      : null,
    pullRequest.approvals > 0 ? plural(pullRequest.approvals, "approval") : null,
    checks.failing > 0 ? plural(checks.failing, "failing check") : null,
    checks.failing === 0 && checks.pending > 0 ? plural(checks.pending, "pending check") : null,
    checks.failing === 0 && checks.pending === 0 && checks.passing > 0 ? "checks passing" : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type PierQuickAction =
  | { readonly kind: "run"; readonly action: PierAction; readonly label: string }
  | { readonly kind: "open_pr"; readonly label: string; readonly url: string }
  | { readonly kind: "none"; readonly label: string; readonly hint: string };

export interface PierMenuItem {
  readonly action: PierAction;
  readonly label: string;
  readonly disabledReason: string | null;
}

function readPierStatus(status: VcsStatusResult) {
  const pier = status.pier;
  return {
    dirty: status.hasWorkingTreeChanges,
    behind: status.behindCount > 0 || pier?.mainRewritten === true,
    landing: pier?.landing ?? null,
    conflicts: pier?.conflicts ?? [],
    pinnedIsMain: pier?.pinnedIsMain ?? false,
    // Main, the landing and the conflicts are unknown until the server answers.
    serverUnknown: pier === undefined || pier.serverError !== null,
  };
}

/** One line on what the pier server said, or could not say, of the checkout. */
export function describePierServerState(status: VcsStatusResult | null): string | null {
  const pier = status?.pier;
  if (pier?.serverError) return `pier server: ${pier.serverError}`;
  if (pier?.mainRewritten)
    return "Main was force-pushed past this checkout's base. Rebase onto it.";
  return null;
}

const SERVER_UNKNOWN_HINT = "Waiting for the pier server to say where main and the landing stand.";

/** The one action the split button offers, as git's quick action does. */
export function resolvePierQuickAction(status: VcsStatusResult | null): PierQuickAction {
  if (status === null) {
    return { kind: "none", label: "Land", hint: "Reading the checkout's status." };
  }
  const { dirty, behind, landing, conflicts, pinnedIsMain, serverUnknown } = readPierStatus(status);
  if (serverUnknown) {
    return dirty
      ? { kind: "run", action: "commit", label: "Commit" }
      : {
          kind: "none",
          label: "Land",
          hint: describePierServerState(status) ?? SERVER_UNKNOWN_HINT,
        };
  }
  if (dirty) return { kind: "run", action: "commit_land", label: "Commit & land" };
  if (conflicts.length > 0) {
    return {
      kind: "none",
      label: "Settle conflicts",
      hint: "Edit out the conflict markers or run `pier resolve`, then commit.",
    };
  }
  if (isPierLandingOpen(landing)) {
    return landing?.pullRequest
      ? { kind: "open_pr", label: "View PR", url: landing.pullRequest.url }
      : { kind: "none", label: "Landing", hint: "Waiting for pier to open the pull request." };
  }
  if (behind) return { kind: "run", action: "rebase", label: "Rebase onto main" };
  if (pinnedIsMain || landing?.state === "landed") {
    return { kind: "none", label: "Land", hint: "Nothing to land: commit some edits first." };
  }
  return { kind: "run", action: "land", label: "Land" };
}

export function buildPierMenuItems(status: VcsStatusResult | null): ReadonlyArray<PierMenuItem> {
  if (status === null) return [];
  const { dirty, behind, landing, conflicts, pinnedIsMain, serverUnknown } = readPierStatus(status);
  const serverReason = serverUnknown
    ? (describePierServerState(status) ?? SERVER_UNKNOWN_HINT)
    : null;
  const landReason =
    serverReason ??
    (dirty
      ? null
      : conflicts.length > 0
        ? "Settle the conflicts and commit first."
        : isPierLandingOpen(landing)
          ? "This changeset is already landing."
          : pinnedIsMain || landing?.state === "landed"
            ? "Nothing to land: commit some edits first."
            : null);
  return [
    {
      action: "commit",
      label: "Commit",
      disabledReason: dirty ? null : "There are no uncommitted edits.",
    },
    {
      action: dirty ? "commit_land" : "land",
      label: dirty ? "Commit & land" : "Land",
      disabledReason: landReason,
    },
    ...(isPierLandingCancellable(landing)
      ? [{ action: "cancel_land" as const, label: "Cancel landing", disabledReason: null }]
      : []),
    {
      action: "rebase",
      label: "Rebase onto main",
      disabledReason:
        serverReason ??
        (dirty
          ? "Commit or discard the uncommitted edits first."
          : behind
            ? null
            : "Already on main's tip."),
    },
  ];
}

export const PIER_ACTION_PROGRESS_LABELS: Record<PierAction, string> = {
  commit: "Committing...",
  land: "Landing...",
  commit_land: "Committing and landing...",
  cancel_land: "Cancelling landing...",
  rebase: "Rebasing...",
};

export function summarizePierActionResult(result: PierRunActionResult): {
  readonly title: string;
  readonly description: string | null;
} {
  const subject = result.commit?.subject ?? null;
  if (result.rebase !== null) {
    const { rebased, conflicts } = result.rebase;
    return conflicts.length > 0
      ? { title: "Rebased with conflicts", description: conflicts.join(", ") }
      : { title: `Rebased ${plural(rebased, "changeset")} onto main`, description: null };
  }
  if (result.landing !== null) {
    return result.action === "cancel_land"
      ? { title: "Landing cancelled", description: null }
      : { title: describePierLanding(result.landing).label, description: subject };
  }
  return {
    title: `Committed ${result.commit?.id.slice(0, 12) ?? ""}`.trim(),
    description: subject,
  };
}
