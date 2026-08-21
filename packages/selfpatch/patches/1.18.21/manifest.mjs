import { manifest as base } from "../1.18.19/manifest.mjs"

// OpenCode v1.18.21 keeps 11 of 12 reviewed Alonix host boundaries
// byte-identical to v1.18.19. The session prompt changed upstream, but every
// reviewed replacement anchor was proven to apply exactly to pristine v1.18.21
// source before this profile was added. Bind those unchanged patch bodies to
// the new official fingerprint.
const SESSION_PROMPT = "packages/opencode/src/session/prompt.ts"
const SESSION_PROMPT_SHA256 = "f0c5bc64c0f0e966693d4a57f7ede1e9d6e188b396152f04b55303dc75b9b768"

export const manifest = {
  ...base,
  version: "1.18.21",
  files: base.files.map((entry) => entry.path === SESSION_PROMPT
    ? { ...entry, beforeSha256: SESSION_PROMPT_SHA256 }
    : entry),
}

if (manifest.files.find((entry) => entry.path === SESSION_PROMPT)?.beforeSha256 !== SESSION_PROMPT_SHA256) {
  throw new Error("OpenCode v1.18.21 profile is missing the verified session-prompt fingerprint")
}
