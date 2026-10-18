import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";

import * as ProcessRunner from "../../processRunner.ts";

const PIER_COMMAND = "pier";
// A checkout downloads the cone's files, which can outlast the default timeout.
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

/** Only the fields `pier status --json` keeps when its server is unreachable are required. */
const PierStatus = Schema.Struct({
  ...PierCheckoutFields,
  main_error: Schema.optional(Schema.NullOr(Schema.String)),
  conflicts: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String })),
  ),
  uncommitted: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.Literals(["added", "modified", "deleted"]),
    }),
  ),
});
type PierStatus = typeof PierStatus.Type;

const decodeCheckout = Schema.decodeUnknownEffect(Schema.fromJsonString(PierCheckout));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(PierStatus));

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
    /** Whether `pier` resolves on the server's PATH. */
    readonly isAvailable: Effect.Effect<boolean>;
    /** Whether `directory` is the root of a pier checkout. */
    readonly isCheckout: (directory: string) => Effect.Effect<boolean>;
    readonly status: (cwd: string) => Effect.Effect<PierStatus, PierCliError>;
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
     * `agent`, so a checkout someone else pointed at is left alone.
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
              new PierCliError({ operation, cwd, detail: "pier is not on the server's PATH." }),
            )
          : Effect.succeed(resolved),
      ),
    );

  const run = Effect.fn("PierCli.run")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly json?: boolean },
  ) {
    const command = yield* executable(operation, cwd);
    const output = yield* processRunner
      .run({
        command,
        args: options?.json === false ? args : [...args, "--json"],
        cwd,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
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
    return output.stdout;
  });

  const decodeError = (operation: string, cwd: string) => (cause: unknown) =>
    new PierCliError({ operation, cwd, detail: "pier printed unexpected JSON.", cause });

  const isAvailable: PierCli["Service"]["isAvailable"] = findPier.pipe(
    Effect.map((resolved) => resolved !== null),
    Effect.orElseSucceed(() => false),
  );

  const isCheckout: PierCli["Service"]["isCheckout"] = (directory) =>
    fileSystem
      .exists(path.join(directory, ".pier", "checkout.json"))
      .pipe(Effect.orElseSucceed(() => false));

  const status: PierCli["Service"]["status"] = (cwd) =>
    run("status", cwd, ["status"], { timeoutMs: STATUS_TIMEOUT_MS }).pipe(
      Effect.flatMap((stdout) =>
        decodeStatus(stdout).pipe(Effect.mapError(decodeError("status", cwd))),
      ),
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
      Effect.flatMap((stdout) =>
        decodeCheckout(stdout).pipe(Effect.mapError(decodeError("checkout", cwd))),
      ),
    );
  };

  const checkoutLike: PierCli["Service"]["checkoutLike"] = (input) =>
    status(input.source).pipe(
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
        yield* status(directory).pipe(
          Effect.flatMap((current) =>
            current.agent === options.agent
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

  return PierCli.of({ isAvailable, isCheckout, status, checkout, checkoutLike, removeCheckout });
});

export const layer = Layer.effect(PierCli, make);
