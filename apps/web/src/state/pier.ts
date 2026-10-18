import { createPierEnvironmentAtoms } from "@t3tools/client-runtime/state/pier";

import { connectionAtomRuntime } from "../connection/runtime";

export const pierEnvironment = createPierEnvironmentAtoms(connectionAtomRuntime);
