import { manifest as base } from "../1.18.29/manifest.mjs"

// OpenCode v1.18.32 keeps 11 of 12 reviewed Alonix host boundaries
// byte-identical to v1.18.29. The app.tsx layout root changed upstream, but
// every reviewed replacement anchor was proven to apply exactly to pristine
// v1.18.32 source before this profile was added. Bind those unchanged patch
// bodies to the new official fingerprint.
const APP_TSX = "packages/tui/src/app.tsx"
const APP_TSX_SHA256 = "c99db2d432450e34cbd2b101a4414e075a510679e1e065cc3d4245c3d3170e5f"

export const manifest = {
  ...base,
  version: "1.18.32",
  files: base.files.map((entry) =>
    entry.path === APP_TSX
      ? { ...entry, beforeSha256: APP_TSX_SHA256 }
      : entry
  ),
}

if (manifest.files.find((entry) => entry.path === APP_TSX)?.beforeSha256 !== APP_TSX_SHA256) {
  throw new Error("OpenCode v1.18.32 profile is missing the verified app.tsx fingerprint")
}
