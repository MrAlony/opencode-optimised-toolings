import { manifest as base } from "../1.18.13/manifest.mjs"

// OpenCode v1.18.15 keeps every Alonix patch anchor exact, but changed two
// touched host files around those anchors. Bind the proven patch bodies to the
// official v1.18.15 fingerprints instead of weakening capability validation.
const beforeSha256 = new Map([
  ["packages/tui/src/context/sync.tsx", "452035470d52b6bb3cfd58eea9df612942510126e8f759279c46c1de4899a2ab"],
  ["packages/tui/src/routes/session/index.tsx", "90f0471caac6eac5768cf4358d4371207dd69362affeddb4ea0f30133a7e576c"],
  ["packages/tui/src/prompt/history.tsx", "ebf619998f067afd0d0c590b98366cb8bf87a527cd0ef366679ec883084def27"],
  ["packages/tui/src/component/prompt/index.tsx", "fed47f1ef68ee6d96db553749570d073e539d0544e89aa5968ff1f55a3828d6e"],
  ["packages/plugin/src/tui.ts", "3b0ccca22ebf8558afb9dc055505c7c503930f2f622d1db8c3fb9ca3e9278e8c"],
  ["packages/opencode/src/plugin/tui/runtime.ts", "f454bc0c2ec61d5cf605f4c65b2223692cd6731f501fd64a4a762a8868c69e70"],
  ["packages/opencode/src/config/tui.ts", "7d7b30d41d5c04ea443819727490142406d293e031dcc221babeb3da1db3e902"],
  ["packages/opencode/src/plugin/shared.ts", "1ada9e15915e47bbb7b16436f0018c9b86845a66e687d89d037be896b9663140"],
  ["packages/opencode/src/session/prompt.ts", "0ef73c460d46619cd3e75d4b790a22a3c4c999b311a43e7887b634ff7a3fa06d"],
  ["packages/tui/src/app.tsx", "c0715487889226993d4d6f3938880aad999704ca89211dcd70cbf77ec5b1e3d7"],
  ["packages/tui/src/plugin/adapters.tsx", "ecff9bb3a2d1acf0f4ee6d1dacf213ee059d88fa22cedced8cafa51dfb4eb353"],
  ["packages/tui/src/routes/home/session-destination.tsx", "6bd539d6ce6ece6bb0b5b94e186fe8b06ad06559fa97dae17ea52bf3f14ecc90"],
])

export const manifest = {
  ...base,
  version: "1.18.15",
  files: base.files.map((entry) => ({
    ...entry,
    beforeSha256: beforeSha256.get(entry.path) ?? entry.beforeSha256,
  })),
}

for (const entry of manifest.files) {
  if (!beforeSha256.has(entry.path)) {
    throw new Error(`OpenCode v1.18.15 profile is missing an official fingerprint for ${entry.path}`)
  }
}
