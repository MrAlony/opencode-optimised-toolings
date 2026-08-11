import { manifest as base } from "../1.18.15/manifest.mjs"

// OpenCode v1.18.16 is byte-identical to v1.18.15 for every host file touched
// by the Alonix patch. Keep an explicit exact profile so an automatic OpenCode
// update cannot temporarily fall back to the unbounded native transcript while
// still retaining strict per-file fingerprint validation.
export const manifest = {
  ...base,
  version: "1.18.16",
}
