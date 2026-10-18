import type { PierLanding, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPierMenuItems,
  describePierServerState,
  resolvePierQuickAction,
  summarizePierActionResult,
  summarizePierPullRequest,
} from "./pier.ts";

const landing = (state: PierLanding["state"], url?: string): PierLanding => ({
  id: 3,
  tip: "cs-pinned",
  state,
  reasons: [],
  landed: null,
  pullRequest:
    url === undefined
      ? null
      : {
          number: 42,
          url,
          approvals: 0,
          changesRequested: 0,
          checks: { pending: 0, passing: 0, failing: 0 },
        },
});

const status = (input: {
  readonly dirty?: boolean;
  readonly behind?: number;
  readonly landing?: PierLanding | null;
  readonly conflicts?: ReadonlyArray<string>;
  readonly pinnedIsMain?: boolean;
  readonly mainRewritten?: boolean;
  readonly serverError?: string | null;
  /** Leaves out the server's part, as before the remote status arrives. */
  readonly noRemote?: boolean;
}): VcsStatusResult => ({
  isRepo: true,
  pierCheckout: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: "t3-0123abcd",
  hasWorkingTreeChanges: input.dirty ?? false,
  workingTree: {
    files: input.dirty ? [{ path: "src/a.ts", insertions: 0, deletions: 0 }] : [],
    insertions: 0,
    deletions: 0,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: input.behind ?? 0,
  pr: null,
  ...(input.noRemote
    ? {}
    : {
        pier: {
          pinned: "cs-pinned",
          pinnedIsMain: input.pinnedIsMain ?? false,
          mainRewritten: input.mainRewritten ?? false,
          landing: input.landing ?? null,
          serverError: input.serverError ?? null,
          conflicts: input.conflicts ?? [],
        },
      }),
});

describe("resolvePierQuickAction", () => {
  it("commits and lands uncommitted edits, even over an open landing", () => {
    expect(
      resolvePierQuickAction(status({ dirty: true, landing: landing("pr_open", "u") })),
    ).toEqual({ kind: "run", action: "commit_land", label: "Commit & land" });
  });

  it("opens the landing's pull request once pier has one, and waits until then", () => {
    expect(resolvePierQuickAction(status({ landing: landing("pr_open", "https://pr") }))).toEqual({
      kind: "open_pr",
      label: "View PR",
      url: "https://pr",
    });
    expect(resolvePierQuickAction(status({ landing: landing("pending") })).kind).toBe("none");
  });

  it("rebases when main moved on, and lands a committed changeset otherwise", () => {
    expect(resolvePierQuickAction(status({ behind: 2 }))).toMatchObject({ action: "rebase" });
    expect(resolvePierQuickAction(status({ landing: landing("flagged") }))).toMatchObject({
      action: "land",
    });
    expect(resolvePierQuickAction(status({ pinnedIsMain: true })).kind).toBe("none");
  });

  it("rebases onto a main that was force-pushed past the checkout's base", () => {
    const rewritten = status({ mainRewritten: true });
    expect(resolvePierQuickAction(rewritten)).toMatchObject({ action: "rebase" });
    expect(buildPierMenuItems(rewritten).find((item) => item.action === "rebase")).toMatchObject({
      disabledReason: null,
    });
    expect(describePierServerState(rewritten)).toMatch(/force-pushed/u);
  });

  it("neither lands nor rebases while the server's answer is missing", () => {
    const offline = status({ behind: 2, serverError: "not logged in: run `pier login`" });
    expect(resolvePierQuickAction(offline)).toEqual({
      kind: "none",
      label: "Land",
      hint: "pier server: not logged in: run `pier login`",
    });
    expect(resolvePierQuickAction(status({ dirty: true, serverError: "offline" }))).toEqual({
      kind: "run",
      action: "commit",
      label: "Commit",
    });
    expect(resolvePierQuickAction(status({ noRemote: true })).kind).toBe("none");
    const reasons = Object.fromEntries(
      buildPierMenuItems(offline).map((item) => [item.action, item.disabledReason]),
    );
    expect(reasons.land).toBe("pier server: not logged in: run `pier login`");
    expect(reasons.rebase).toBe("pier server: not logged in: run `pier login`");
  });

  it("asks for conflicts to be settled before anything lands", () => {
    expect(resolvePierQuickAction(status({ conflicts: ["src/a.ts"], behind: 1 }))).toMatchObject({
      kind: "none",
      label: "Settle conflicts",
    });
  });
});

describe("buildPierMenuItems", () => {
  it("offers cancel only while pier still accepts it", () => {
    const actions = (state: PierLanding["state"]) =>
      buildPierMenuItems(status({ landing: landing(state) })).map((item) => item.action);
    expect(actions("pr_open")).toContain("cancel_land");
    expect(actions("merging")).not.toContain("cancel_land");
    expect(actions("cancelled")).not.toContain("cancel_land");
  });

  it("explains why commit and rebase are unavailable", () => {
    const reasons = Object.fromEntries(
      buildPierMenuItems(status({ dirty: true })).map((item) => [item.action, item.disabledReason]),
    );
    expect(reasons).toEqual({
      commit: null,
      commit_land: null,
      rebase: "Commit or discard the uncommitted edits first.",
    });
    expect(buildPierMenuItems(status({})).find((item) => item.action === "commit")).toMatchObject({
      disabledReason: "There are no uncommitted edits.",
    });
  });
});

describe("summaries", () => {
  it("names what blocks a pull request before what passes", () => {
    expect(
      summarizePierPullRequest({
        number: 1,
        url: "u",
        approvals: 1,
        changesRequested: 0,
        checks: { pending: 2, passing: 1, failing: 1 },
      }),
    ).toBe("1 approval · 1 failing check");
  });

  it("reports a rebase's conflicts", () => {
    expect(
      summarizePierActionResult({
        action: "rebase",
        commit: null,
        landing: null,
        rebase: { rebased: 1, head: "cs-new", conflicts: ["src/a.ts", "src/b.ts"] },
      }),
    ).toEqual({ title: "Rebased with conflicts", description: "src/a.ts, src/b.ts" });
  });
});
