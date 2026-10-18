import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { PIER_OPEN_LANDING_STATES, PierLandingState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";

import * as ProcessRunner from "../../processRunner.ts";

const PIER_COMMAND = "pier";
// A checkout downloads the cone's files, and a commit or rebase uploads and
// writes them, any of which can outlast the default timeout.
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// `pier status` asks the server four questions; a slow server reads as an error, not a stall.
const STATUS_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1_000_000;
// pier waits on its server, so it gets permits of its own rather than git's.
const PIER_PROCESS_CONCURRENCY = 3;

const PierCheckoutFields = {
  root: Schema.String,
  /** Null for a checkout made before pier recorded its server. */
  server: Schema.NullOr(Schema.String),
  upstream: Schema.String,
  pinned: Schema.String,
  agent: Schema.NullOr(Schema.String),
  cone: Schema.Array(Schema.String),
};

const PierCheckout = Schema.Struct({
  ...PierCheckoutFields,
  files: Schema.Number,
});
type PierCheckout = typeof PierCheckout.Type;

const PierLandingView = Schema.Struct({
  id: Schema.Number,
  tip: Schema.String,
  state: PierLandingState,
  reasons: Schema.optional(Schema.Array(Schema.String)),
  landed: Schema.NullOr(Schema.String),
  pull_request: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Number,
        url: Schema.String,
        reviews: Schema.optional(
          Schema.Array(
            Schema.Struct({
              login: Schema.String,
              state: Schema.Literals(["approved", "changes_requested", "commented"]),
            }),
          ),
        ),
        checks: Schema.optional(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              conclusion: Schema.Literals(["pending", "success", "failure"]),
            }),
          ),
        ),
      }),
    ),
  ),
});
export type PierLandingView = typeof PierLandingView.Type;

const PierCommitted = Schema.Struct({
  id: Schema.String,
  changes: Schema.Number,
  blobs: Schema.Number,
  uploaded: Schema.Number,
});
export type PierCommitted = typeof PierCommitted.Type;

const PierRebased = Schema.Struct({
  onto: Schema.String,
  git: Schema.String,
  head: Schema.String,
  rebased: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  conflicts: Schema.optional(Schema.Array(Schema.String)),
});
export type PierRebased = typeof PierRebased.Type;

/**
 * Only the fields `pier status --json --local` prints are required. The server's
 * parts are absent with `--local`, and null beside an error when unreachable.
 */
const PierStatus = Schema.Struct({
  ...PierCheckoutFields,
  main: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        base: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ state: Schema.String, commits: Schema.optional(Schema.Number) }),
          ),
        ),
      }),
    ),
  ),
  main_error: Schema.optional(Schema.NullOr(Schema.String)),
  /** The pinned changeset is already on main, so the checkout has nothing of its own to land. */
  on_main: Schema.optional(Schema.NullOr(Schema.Boolean)),
  on_main_error: Schema.optional(Schema.NullOr(Schema.String)),
  landing: Schema.optional(Schema.NullOr(PierLandingView)),
  landing_error: Schema.optional(Schema.NullOr(Schema.String)),
  conflicts: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String }))),
  ),
  conflicts_error: Schema.optional(Schema.NullOr(Schema.String)),
  /** Conflicts `pier resolve` settled, which the next commit records. */
  resolved: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, took: Schema.String })),
  ),
  uncommitted: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.Literals(["added", "modified", "deleted"]),
    }),
  ),
});
export type PierStatus = typeof PierStatus.Type;

const decodeCheckout = Schema.decodeUnknownEffect(Schema.fromJsonString(PierCheckout));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(PierStatus));
const decodeLanding = Schema.decodeUnknownEffect(Schema.fromJsonString(PierLandingView));
const decodeCommitted = Schema.decodeUnknownEffect(Schema.fromJsonString(PierCommitted));
const decodeRebased = Schema.decodeUnknownEffect(Schema.fromJsonString(PierRebased));

export class PierCliError extends Schema.TaggedError<PierCliError>()("PierCliError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `pier ${this.operation} failed: ${this.detail}`;
  }
}

interface PierCheckoutInput {
  /** Null leaves pier to pick its default server. */
  readonly server: string | null;
  readonly upstream: string;
  readonly directory: string;
  readonly agent: string;
  readonly cone: ReadonlyArray<string>;
}

export class PierCli extends Context.Service<
  PierCli,
  {
    /** Whether `directory` is the root of a pier checkout. */
    readonly isCheckout: (directory: string) => Effect.Effect<boolean>;
    /** The nearest directory at or above `cwd` that is the root of a pier checkout. */
    readonly findCheckoutRoot: (cwd: string) => Effect.Effect<string | null>;
    /** `pier status`, asking the server for main, the landing and conflicts. */
    readonly status: (cwd: string) => Effect.Effect<PierStatus, PierCliError>;
    /** `pier status --local`: the checkout alone, without a server call. */
    readonly localStatus: (cwd: string) => Effect.Effect<PierStatus, PierCliError>;
    /** `pier diff` with `args`, as a git-style patch cut off at `maxOutputBytes`. */
    readonly diff: (
      cwd: string,
      args: ReadonlyArray<string>,
      maxOutputBytes: number,
    ) => Effect.Effect<{ readonly patch: string; readonly truncated: boolean }, PierCliError>;
    /** Commits the checkout's edits and re-pins it to the new changeset. */
    readonly commit: (cwd: string, message: string) => Effect.Effect<PierCommitted, PierCliError>;
    /** Files a landing request for `changeset`, or withdraws its latest one. */
    readonly land: (
      cwd: string,
      changeset: string,
      options?: { readonly cancel?: boolean },
    ) => Effect.Effect<PierLandingView, PierCliError>;
    /** Moves the checkout's chain onto main's tip; refused while it has edits. */
    readonly rebase: (cwd: string) => Effect.Effect<PierRebased, PierCliError>;
    /** Creates `directory`, which must be missing or empty. */
    readonly checkout: (input: PierCheckoutInput) => Effect.Effect<PierCheckout, PierCliError>;
    /** Lays out a checkout of the same upstream, server and cone as the one at `source`. */
    readonly checkoutLike: (input: {
      readonly source: string;
      readonly directory: string;
      readonly agent: string;
    }) => Effect.Effect<PierCheckout, PierCliError>;
    /**
     * Deletes the directory. pier has no delete command. The pinned changeset
     * is abandoned first, best effort, only when the checkout belongs to
     * `agent` and has no landing under way.
     */
    readonly removeCheckout: (
      directory: string,
      options: { readonly agent: string },
    ) => Effect.Effect<void, PierCliError>;
  }
>()("t3/vcs/pier/PierCli") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.make();
  const processes = yield* Semaphore.make(PIER_PROCESS_CONCURRENCY);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Usually `process.env` itself, so a PATH fixed up after startup still counts.
  const environment = yield* HostProcess.Environment;
  const findPier = resolveCommandPath(PIER_COMMAND, { env: environment }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const executable = (operation: string, cwd: string) =>
    findPier.pipe(
      Effect.flatMap((resolved) =>
        resolved === null
          ? Effect.fail(
              new PierCliError({ operation, cwd, detail: "pier isn't on the server's PATH." }),
            )
          : Effect.succeed(resolved),
      ),
    );

  const run = Effect.fn("PierCli.run")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly timeoutMs?: number;
      readonly json?: boolean;
      readonly maxOutputBytes?: number;
    },
  ) {
    const command = yield* executable(operation, cwd);
    const output = yield* processRunner
      .run({
        command,
        args: options?.json === false ? args : [...args, "--json"],
        cwd,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: options?.maxOutputBytes ?? MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "error",
      })
      .pipe(
        processes.withPermits(1),
        Effect.mapError(
          (cause) => new PierCliError({ operation, cwd, detail: cause.message, cause }),
        ),
      );
    if (output.code !== 0) {
      const message = output.stderr
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return yield* new PierCliError({
        operation,
        cwd,
        detail: message?.replace(/^pier:\s*/, "") ?? `exited with ${output.code}`,
      });
    }
    return output;
  });

  const decodeError = (operation: string, cwd: string) => (cause: unknown) =>
    new PierCliError({ operation, cwd, detail: "pier printed unexpected JSON.", cause });

  const isCheckout: PierCli["Service"]["isCheckout"] = (directory) =>
    fileSystem
      .exists(path.join(directory, ".pier", "checkout.json"))
      .pipe(Effect.orElseSucceed(() => false));

  const findCheckoutRoot: PierCli["Service"]["findCheckoutRoot"] = Effect.fn(
    "PierCli.findCheckoutRoot",
  )(function* (cwd) {
    let current = path.resolve(cwd);
    while (true) {
      if (yield* isCheckout(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  });

  const status: PierCli["Service"]["status"] = (cwd) =>
    run("status", cwd, ["status"], { timeoutMs: STATUS_TIMEOUT_MS }).pipe(
      Effect.flatMap((output) =>
        decodeStatus(output.stdout).pipe(Effect.mapError(decodeError("status", cwd))),
      ),
    );

  const localStatus: PierCli["Service"]["localStatus"] = (cwd) =>
    run("status", cwd, ["status", "--local"]).pipe(
      Effect.flatMap((output) =>
        decodeStatus(output.stdout).pipe(Effect.mapError(decodeError("status", cwd))),
      ),
    );

  const commit: PierCli["Service"]["commit"] = (cwd, message) =>
    run("commit", cwd, ["commit", "-m", message], { timeoutMs: CHECKOUT_TIMEOUT_MS }).pipe(
      Effect.flatMap((output) =>
        decodeCommitted(output.stdout).pipe(Effect.mapError(decodeError("commit", cwd))),
      ),
    );

  const land: PierCli["Service"]["land"] = (cwd, changeset, options) =>
    run("land", cwd, ["land", changeset, ...(options?.cancel ? ["--cancel"] : [])]).pipe(
      Effect.flatMap((output) =>
        decodeLanding(output.stdout).pipe(Effect.mapError(decodeError("land", cwd))),
      ),
    );

  const rebase: PierCli["Service"]["rebase"] = (cwd) =>
    run("rebase", cwd, ["rebase"], { timeoutMs: CHECKOUT_TIMEOUT_MS }).pipe(
      Effect.flatMap((output) =>
        decodeRebased(output.stdout).pipe(Effect.mapError(decodeError("rebase", cwd))),
      ),
    );

  const diff: PierCli["Service"]["diff"] = (cwd, args, maxOutputBytes) =>
    run("diff", cwd, ["diff", ...args], { json: false, maxOutputBytes }).pipe(
      Effect.map((output) => ({ patch: output.stdout, truncated: output.stdoutTruncated })),
    );

  const checkout: PierCli["Service"]["checkout"] = (input) => {
    const cwd = path.dirname(input.directory);
    return fileSystem.makeDirectory(cwd, { recursive: true }).pipe(
      Effect.mapError(
        (cause) => new PierCliError({ operation: "checkout", cwd, detail: cause.message, cause }),
      ),
      Effect.andThen(
        run(
          "checkout",
          cwd,
          [
            ...(input.server === null ? [] : ["--server", input.server]),
            "--upstream",
            input.upstream,
            "checkout",
            input.directory,
            "--agent",
            input.agent,
            ...input.cone.flatMap((directory) => ["--cone", directory]),
          ],
          { timeoutMs: CHECKOUT_TIMEOUT_MS },
        ),
      ),
      Effect.flatMap((output) =>
        decodeCheckout(output.stdout).pipe(Effect.mapError(decodeError("checkout", cwd))),
      ),
    );
  };

  const checkoutLike: PierCli["Service"]["checkoutLike"] = (input) =>
    localStatus(input.source).pipe(
      Effect.flatMap((source) =>
        checkout({
          server: source.server,
          upstream: source.upstream,
          directory: input.directory,
          agent: input.agent,
          cone: source.cone,
        }),
      ),
    );

  const removeCheckout: PierCli["Service"]["removeCheckout"] = Effect.fn("PierCli.removeCheckout")(
    function* (directory, options) {
      if (yield* isCheckout(directory)) {
        // The server lets a changeset whose landing is under way be abandoned,
        // so one is left alone unless its landing is known to be settled.
        yield* status(directory).pipe(
          Effect.flatMap((current) =>
            current.agent === options.agent &&
            current.landing_error == null &&
            !(current.landing != null && PIER_OPEN_LANDING_STATES.has(current.landing.state))
              ? run("abandon", directory, ["abandon", current.pinned], { json: false })
              : Effect.void,
          ),
          Effect.ignore,
        );
      }
      yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new PierCliError({
              operation: "remove",
              cwd: directory,
              detail: cause.message,
              cause,
            }),
        ),
      );
    },
  );

  return PierCli.of({
    isCheckout,
    findCheckoutRoot,
    status,
    localStatus,
    commit,
    land,
    rebase,
    diff,
    checkout,
    checkoutLike,
    removeCheckout,
  });
});

export const layer = Layer.effect(PierCli, make);
