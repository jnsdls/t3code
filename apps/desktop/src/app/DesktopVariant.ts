declare const __T3CODE_DESKTOP_VARIANT__: string | undefined;

export interface DesktopVariant {
  readonly t3HomeName: string;
  readonly userDataName: string;
  readonly stageLabel: "Pier" | undefined;
}

const OFFICIAL: DesktopVariant = {
  t3HomeName: ".t3",
  userDataName: "t3code-v2",
  stageLabel: undefined,
};

// A fork built with T3CODE_DESKTOP_VARIANT=pier installs beside the official app
// and must never read or write its T3 home or Electron profile.
const PIER: DesktopVariant = {
  t3HomeName: ".t3-pier",
  userDataName: "t3code-pier",
  stageLabel: "Pier",
};

export const resolveDesktopVariant = (name: string | undefined): DesktopVariant =>
  name?.trim() === "pier" ? PIER : OFFICIAL;

export const desktopVariant = resolveDesktopVariant(
  typeof __T3CODE_DESKTOP_VARIANT__ === "undefined" ? undefined : __T3CODE_DESKTOP_VARIANT__,
);
