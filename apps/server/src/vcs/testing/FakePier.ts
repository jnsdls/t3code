import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Answers the commands T3 runs. `checkout` lays out nothing but the marker,
// and fails half-way once a `fail-checkout` file sits beside the script.
// `status` prints `status.json` from beside the script when present.
const SCRIPT = `#!/bin/sh
here="$(dirname "$0")"
printf '%s|%s\\n' "$PWD" "$*" >> "$here/calls.log"
while [ $# -gt 0 ]; do
  case "$1" in
    --server|--upstream) shift 2 ;;
    *) break ;;
  esac
done
case "$1" in
  status)
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
    /** What `pier status --json` prints from now on. */
    setStatus: (status: Record<string, unknown>) =>
      fileSystem.writeFileString(path.join(directory, "status.json"), JSON.stringify(status)),
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
