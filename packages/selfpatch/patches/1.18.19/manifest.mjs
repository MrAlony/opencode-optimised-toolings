import { manifest as base } from "../1.18.16/manifest.mjs"

// OpenCode v1.18.19 keeps every reviewed Alonix patch boundary byte-identical
// except the session route. All 21 session-route replacement anchors were
// validated exactly against the pristine v1.18.19 source before this profile
// was added; bind the unchanged patch bodies to the new official fingerprint.
const SESSION_ROUTE = "packages/tui/src/routes/session/index.tsx"
const SESSION_ROUTE_SHA256 = "f938131c6cf84459c67e83a3936584717f00b6dfaf8c3398a2233ed18308b002"

export const manifest = {
  ...base,
  version: "1.18.19",
  files: base.files.map((entry) => entry.path === SESSION_ROUTE
    ? { ...entry, beforeSha256: SESSION_ROUTE_SHA256 }
    : entry),
}

if (manifest.files.find((entry) => entry.path === SESSION_ROUTE)?.beforeSha256 !== SESSION_ROUTE_SHA256) {
  throw new Error("OpenCode v1.18.19 profile is missing the verified session-route fingerprint")
}
