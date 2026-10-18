import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Answers the commands T3 runs. `checkout` lays out nothing but the marker, and
// fails half-way once a `fail-checkout` file sits beside the script. `status`
// and `diff` print `status.json` (`status-local.json` for `--local`) and
// `diff-<from>.patch` from beside the script when present. `commit` answers
// changeset `cs-committed`, `land` prints `landing.json` or a pending request,
// and `rebase` prints `rebase.json`. A `refuse-<command>` file beside the script
// makes that command fail with its contents.
const SCRIPT = `#!/bin/sh
here="$(dirname "$0")"
printf '%s|%s\\n' "$PWD" "$*" >> "$here/calls.log"
while [ $# -gt 0 ]; do
  case "$1" in
    --server|--upstream) shift 2 ;;
    *) break ;;
  esac
done
if [ -e "$here/refuse-$1" ]; then
  printf 'pier: %s\\n' "$(cat "$here/refuse-$1")" >&2
  exit 1
fi
case "$1" in
  status)
    case " $* " in
      *" --local "*) [ -e "$here/status-local.json" ] && { cat "$here/status-local.json"; exit 0; } ;;
    esac
    if [ -e "$here/status.json" ]; then cat "$here/status.json"; exit 0; fi
    printf '{"root":"%s","server":"http://pier.test","upstream":"acme/widgets","pinned":"cs-pinned","agent":null,"cone":["src","docs"],"main":null,"main_error":"offline","landing":null,"conflicts":[],"uncommitted":[]}\\n' "$PWD" ;;
  checkout)
    mkdir -p "$2/.pier"
    if [ -e "$here/fail-checkout" ]; then
      echo "pier: acme/widgets is not served here" >&2
      exit 1
    fi
    printf '{}' > "$2/.pier/checkout.json"
    printf '{"root":"%s","server":"http://pier.test","upstream":"acme/widgets","pinned":"cs-main","agent":null,"cone":["src","docs"],"files":3}\\n' "$2" ;;
  abandon)
    printf '{}\\n' ;;
  commit)
    printf '{"id":"cs-committed","changes":2,"blobs":2,"uploaded":1}\\n' ;;
  land)
    state=pending
    [ "$3" = "--cancel" ] && state=cancelled
    if [ -e "$here/landing.json" ]; then cat "$here/landing.json"; exit 0; fi
    printf '{"id":7,"tip":"%s","state":"%s","landed":null}\\n' "$2" "$state" ;;
  rebase)
    cat "$here/rebase.json" ;;
  diff)
    from="$2"
    [ "$from" = "--merge-base" ] && from="merge-base"
    [ -e "$here/diff-$from.patch" ] && cat "$here/diff-$from.patch"
    exit 0 ;;
  *)
    echo "pier: unknown command" >&2
    exit 2 ;;
esac
`;

/** A `pier` executable on a PATH of its own, recording each call as `cwd|args`. */
export const makeFakePier = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fake-pier-" });
  yield* fileSystem.writeFileString(path.join(directory, "pier"), SCRIPT);
  yield* fileSystem.chmod(path.join(directory, "pier"), 0o755);
  return {
    environment: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
    calls: fileSystem.readFileString(path.join(directory, "calls.log")).pipe(
      Effect.map((log) => log.split("\n").filter((line) => line.length > 0)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    ),
    failCheckouts: fileSystem.writeFileString(path.join(directory, "fail-checkout"), ""),
    /** What `pier status --json` prints from now on, less the server's parts for `--local`. */
    setStatus: (status: Record<string, unknown>) => {
      const {
        main: _main,
        main_error: _mainError,
        on_main: _onMain,
        on_main_error: _onMainError,
        landing: _landing,
        landing_error: _landingError,
        conflicts: _conflicts,
        conflicts_error: _conflictsError,
        ...local
      } = status;
      return fileSystem
        .writeFileString(path.join(directory, "status.json"), JSON.stringify(status))
        .pipe(
          Effect.andThen(
            fileSystem.writeFileString(
              path.join(directory, "status-local.json"),
              JSON.stringify(local),
            ),
          ),
        );
    },
    /** What `pier land --json` prints from now on. */
    setLanding: (landing: object) =>
      fileSystem.writeFileString(path.join(directory, "landing.json"), JSON.stringify(landing)),
    /** What `pier rebase --json` prints. */
    setRebase: (rebased: object) =>
      fileSystem.writeFileString(path.join(directory, "rebase.json"), JSON.stringify(rebased)),
    /** Makes `pier <command>` fail with `message`. */
    refuse: (command: string, message: string) =>
      fileSystem.writeFileString(path.join(directory, `refuse-${command}`), message),
    /** What `pier diff <from>` prints, `from` being a changeset id or `merge-base`. */
    setDiff: (from: string, patch: string) =>
      fileSystem.writeFileString(path.join(directory, `diff-${from}.patch`), patch),
  };
});

/** Lays out the marker `pier checkout` leaves, without running pier. */
export const writePierCheckoutMarker = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.join(directory, ".pier"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, ".pier", "checkout.json"), "{}");
  });
