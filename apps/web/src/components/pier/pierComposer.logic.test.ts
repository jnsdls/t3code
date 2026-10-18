import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  recallPierCheckout,
  rememberPierCheckout,
  resolvePierRequestedEnvMode,
  resolvePierSendBlockReason,
} from "./pierComposer.logic";

describe("resolvePierRequestedEnvMode", () => {
  it("makes every new workspace a pier checkout in a pier checkout", () => {
    expect(resolvePierRequestedEnvMode("worktree", true)).toBe("pier");
    expect(resolvePierRequestedEnvMode("pier", true)).toBe("pier");
    expect(resolvePierRequestedEnvMode("local", true)).toBe("local");
  });

  it("falls back from pier to a worktree once the checkout is known not to be one", () => {
    expect(resolvePierRequestedEnvMode("pier", false)).toBe("worktree");
    expect(resolvePierRequestedEnvMode("worktree", false)).toBe("worktree");
  });

  it("keeps a pier choice while the status is unknown", () => {
    expect(resolvePierRequestedEnvMode("pier", null)).toBe("pier");
    expect(resolvePierRequestedEnvMode("worktree", null)).toBe("worktree");
  });
});

describe("resolvePierSendBlockReason", () => {
  it("holds a pier send only while the first status is loading", () => {
    const reason = (pierCheckout: boolean | null, statusLoading: boolean) =>
      resolvePierSendBlockReason({ requestedEnvMode: "pier", pierCheckout, statusLoading });
    expect(reason(null, true)).toBe("Reading the checkout's status");
    // A failed status lets the send through, for the server to refuse loudly.
    expect(reason(null, false)).toBeNull();
    expect(reason(true, true)).toBeNull();
    expect(
      resolvePierSendBlockReason({
        requestedEnvMode: "local",
        pierCheckout: null,
        statusLoading: true,
      }),
    ).toBeNull();
  });
});

describe("rememberPierCheckout", () => {
  it("recalls a checkout per environment and folder", () => {
    const environmentId = EnvironmentId.make("environment-pier");
    rememberPierCheckout(environmentId, "/work/widgets", true);
    expect(recallPierCheckout(environmentId, "/work/widgets")).toBe(true);
    expect(recallPierCheckout(environmentId, "/work/other")).toBeUndefined();
    expect(recallPierCheckout(environmentId, null)).toBeUndefined();
  });
});
