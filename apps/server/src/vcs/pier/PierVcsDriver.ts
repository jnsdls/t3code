import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type PierLanding,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewSource,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as VcsDriver from "../VcsDriver.ts";
import * as VcsProcess from "../VcsProcess.ts";
import { makePierShadowGit } from "./PierCheckpoints.ts";
import * as PierCli from "./PierCli.ts";

const REVIEW_PATCH_MAX_CHARS = 120_000;
const REVIEW_FILE_PATCH_MAX_CHARS = 1024 * 1024;
// Read whole so the file list stays complete when the shown patch is cut.
const PIER_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

const shortChangesetId = (id: string) => id.slice(0, 12);

/** What the branch label shows: the agent a thread's checkout belongs to, or the pinned changeset. */
export const pierRefName = (status: PierCli.PierStatus) =>
  status.agent ?? shortChangesetId(status.pinned);

export function pierLocalStatus(status: PierCli.PierStatus): VcsStatusLocalResult {
  // A conflict `pier resolve` settled is committed even when its file is untouched.
  const paths = new Set([
    ...status.uncommitted.map((edit) => edit.path),
    ...(status.resolved ?? []).map((resolution) => resolution.path),
  ]);
  // pier reports which files changed but not by how many lines.
  const files = [...paths].map((path) => ({ path, insertions: 0, deletions: 0 }));
  return {
    isRepo: true,
    pierCheckout: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: pierRefName(status),
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { files, insertions: 0, deletions: 0 },
  };
}

export function pierLanding(view: PierCli.PierLandingView): PierLanding {
  const pullRequest = view.pull_request;
  // Each reviewer's reviews come oldest first; the latest one stands.
  const latestReviews = new Map((pullRequest?.reviews ?? []).map((r) => [r.login, r.state]));
  const latest = [...latestReviews.values()];
  const checks = pullRequest?.checks ?? [];
  const countChecks = (conclusion: string) =>
    checks.filter((check) => check.conclusion === conclusion).length;
  return {
    id: view.id,
    tip: view.tip,
    state: view.state,
    reasons: view.reasons ?? [],
    landed: view.landed,
    pullRequest:
      pullRequest == null
        ? null
        : {
            number: pullRequest.number,
            url: pullRequest.url,
            approvals: latest.filter((state) => state === "approved").length,
            changesRequested: latest.filter((state) => state === "changes_requested").length,
            checks: {
              pending: countChecks("pending"),
              passing: countChecks("success"),
              failing: countChecks("failure"),
            },
          },
  };
}

export function pierRemoteStatus(status: PierCli.PierStatus): VcsStatusRemoteResult {
  const base = status.main?.base;
  const resolved = new Set((status.resolved ?? []).map((resolution) => resolution.path));
  const serverError =
    [status.main_error, status.on_main_error, status.landing_error, status.conflicts_error].find(
      (error) => error != null,
    ) ?? null;
  return {
    hasUpstream: false,
    aheadCount: 0,
    behindCount: base?.state === "behind" ? (base.commits ?? 0) : 0,
    aheadOfDefaultCount: 0,
    pr: null,
    pier: {
      pinned: status.pinned,
      pinnedIsMain: status.on_main === true,
      mainRewritten: base?.state === "unreachable",
      landing: status.landing ? pierLanding(status.landing) : null,
      serverError,
      conflicts: (status.conflicts ?? [])
        .map((conflict) => conflict.path)
        .filter((path) => !resolved.has(path)),
    },
  };
}

interface PatchFile {
  readonly path: string;
  readonly text: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Splits `pier diff`'s output, which names each file once as `diff --git a/<path> b/<path>`. */
export function splitPierPatch(patch: string): ReadonlyArray<PatchFile> {
  const files: PatchFile[] = [];
  for (const section of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.*) b\/\1$/.exec(section.split("\n", 1)[0] ?? "");
    if (!header?.[1]) continue;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of section.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (!inHunk) continue;
      else if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    files.push({ path: header[1], text: section, additions, deletions });
  }
  return files;
}

const patchStats = (files: ReadonlyArray<ReviewDiffFileStat>) =>
  files.map((file) => `${file.path}\t${file.additions}\t${file.deletions}`).join("\n");

const cutPatch = (patch: string, limit: number) =>
  patch.length > limit
    ? { diff: `${patch.slice(0, limit)}\n\n[truncated]`, truncated: true }
    : { diff: patch, truncated: false };

/**
 * A pier checkout as a VCS workspace: status and the review diff come from
 * the pier CLI, turn checkpoints from a private git repository beside it.
 * There are no branches, worktrees or remotes; threads get checkouts instead.
 */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const cli = yield* PierCli.make;
  // Test layers that build the VCS registry without a server have no state folder.
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const shadow = yield* makePierShadowGit({
    stateDir: Option.isSome(serverConfig) ? serverConfig.value.stateDir : null,
    findCheckoutRoot: cli.findCheckoutRoot,
  });

  const toVcsError = (operation: string) => (error: PierCli.PierCliError) =>
    new VcsProcessExitError({
      operation,
      command: "pier",
      cwd: error.cwd,
      exitCode: 1,
      detail: error.detail,
    });

  const freshness = Effect.map(DateTime.now, (now) => ({
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  }));

  // The marker alone claims the folder, so git never reaches past it to an
  // enclosing repository; without pier on PATH, pier's own commands fail.
  const findRoot = cli.findCheckoutRoot;

  const status = (operation: string, cwd: string, options?: { readonly local?: boolean }) =>
    (options?.local ? cli.localStatus(cwd) : cli.status(cwd)).pipe(
      Effect.mapError(toVcsError(operation)),
    );

  const getDiffPreview: NonNullable<VcsDriver.VcsDriver["Service"]["getDiffPreview"]> = Effect.fn(
    "PierVcsDriver.getDiffPreview",
  )(function* (input) {
    const operation = "PierVcsDriver.getDiffPreview";
    const current = yield* status(operation, input.cwd, { local: true });
    const [uncommitted, branch] = yield* Effect.all(
      [
        // From the pinned changeset to the files on disk: only what is not yet committed.
        cli.diff(input.cwd, [current.pinned], PIER_DIFF_MAX_OUTPUT_BYTES),
        cli.diff(input.cwd, ["--merge-base"], PIER_DIFF_MAX_OUTPUT_BYTES),
      ],
      { concurrency: 2 },
    ).pipe(Effect.mapError(toVcsError(operation)));

    const source = Effect.fn("PierVcsDriver.getDiffPreview.source")(function* (
      output: { readonly patch: string; readonly truncated: boolean },
      fields: Pick<ReviewDiffPreviewSource, "id" | "kind" | "title" | "baseRef" | "headRef">,
    ) {
      const wanted = input.file?.path;
      const parts = splitPierPatch(output.patch).filter(
        (file) => wanted === undefined || file.path === wanted,
      );
      const files: ReadonlyArray<ReviewDiffFileStat> | undefined = output.truncated
        ? undefined
        : parts.map((file) => ({
            path: file.path,
            previousPath: null,
            additions: file.additions,
            deletions: file.deletions,
          }));
      const cut = cutPatch(
        parts.map((file) => file.text).join(""),
        wanted === undefined ? REVIEW_PATCH_MAX_CHARS : REVIEW_FILE_PATCH_MAX_CHARS,
      );
      const diffHash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`${cut.diff}\0${patchStats(files ?? [])}`))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      return {
        ...fields,
        diff: cut.diff,
        ...(files === undefined ? {} : { files }),
        diffHash,
        truncated: cut.truncated || output.truncated,
      } satisfies ReviewDiffPreviewSource;
    });

    const refName = pierRefName(current);
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [
        yield* source(uncommitted, {
          id: "working-tree",
          kind: "working-tree",
          title: "Uncommitted",
          baseRef: shortChangesetId(current.pinned),
          headRef: null,
        }),
        yield* source(branch, {
          id: "branch-range",
          kind: "branch-range",
          title: "Changes vs main",
          baseRef: "main",
          headRef: refName,
        }),
      ],
    };
  });

  const unsupported = (operation: string, detail: string) =>
    Effect.fail(new VcsUnsupportedOperationError({ operation, kind: "pier", detail }));

  return VcsDriver.VcsDriver.of({
    capabilities: {
      kind: "pier",
      supportsWorktrees: false,
      supportsBookmarks: false,
      supportsAtomicSnapshot: false,
      supportsPushDefaultRemote: false,
      ignoreClassifier: "git-compatible-fallback",
    },
    execute: (input) => vcsProcess.run({ ...input, command: "pier" }),
    checkpoints: shadow.checkpoints,
    detectRepository: Effect.fn("PierVcsDriver.detectRepository")(function* (cwd) {
      const root = yield* findRoot(cwd);
      if (root === null) return null;
      return {
        kind: "pier" as const,
        rootPath: root,
        metadataPath: path.join(root, ".pier"),
        freshness: yield* freshness,
      };
    }),
    isInsideWorkTree: (cwd) => findRoot(cwd).pipe(Effect.map((root) => root !== null)),
    listWorkspaceFiles: shadow.listWorkspaceFiles,
    listRemotes: () => Effect.map(freshness, (observed) => ({ remotes: [], freshness: observed })),
    filterIgnoredPaths: shadow.filterIgnoredPaths,
    initRepository: () =>
      unsupported("PierVcsDriver.initRepository", "Create pier checkouts with `pier checkout`."),
    getDiffPreview,
    localStatus: (cwd) =>
      status("PierVcsDriver.localStatus", cwd, { local: true }).pipe(Effect.map(pierLocalStatus)),
    remoteStatus: (cwd) =>
      status("PierVcsDriver.remoteStatus", cwd).pipe(Effect.map(pierRemoteStatus)),
  });
});
