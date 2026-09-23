import { manifest as base } from "../1.18.13/manifest.mjs"

// OpenCode v1.18.29 keeps 5 of 12 reviewed Alonix host files byte-identical to
// v1.18.21 (shared.ts, runtime.ts, prompt.ts, plugin/tui.ts, history.tsx). The
// remaining 7 files changed upstream: config/tui.ts, app.tsx, the prompt
// component, context/sync.tsx, the plugin adapters, the deferred session
// destination, and the session route. Every reviewed replacement anchor was
// proven to apply exactly to pristine v1.18.29 source before this profile was
// added (validated with the pipeline's strict manifestCompatible proof). Bind
// the reviewed patch bodies to the new official fingerprints.

const HOST_HASHES = {
  "packages/opencode/src/config/tui.ts": "7d7b30d41d5c04ea443819727490142406d293e031dcc221babeb3da1db3e902",
  "packages/opencode/src/plugin/shared.ts": "1ada9e15915e47bbb7b16436f0018c9b86845a66e687d89d037be896b9663140",
  "packages/opencode/src/plugin/tui/runtime.ts": "f454bc0c2ec61d5cf605f4c65b2223692cd6731f501fd64a4a762a8868c69e70",
  "packages/opencode/src/session/prompt.ts": "f0c5bc64c0f0e966693d4a57f7ede1e9d6e188b396152f04b55303dc75b9b768",
  "packages/plugin/src/tui.ts": "3b0ccca22ebf8558afb9dc055505c7c503930f2f622d1db8c3fb9ca3e9278e8c",
  "packages/tui/src/app.tsx": "a3c1c44346e6e1fc25d43dddc7b7053c6b1b840bed94e409def6351a9033e649",
  "packages/tui/src/component/prompt/index.tsx": "e8c0153b5b9dcf5b00e334d6063126dfffe5cb41333b55621d92f54e8d18639c",
  "packages/tui/src/context/sync.tsx": "452035470d52b6bb3cfd58eea9df612942510126e8f759279c46c1de4899a2ab",
  "packages/tui/src/plugin/adapters.tsx": "ecff9bb3a2d1acf0f4ee6d1dacf213ee059d88fa22cedced8cafa51dfb4eb353",
  "packages/tui/src/prompt/history.tsx": "ebf619998f067afd0d0c590b98366cb8bf87a527cd0ef366679ec883084def27",
  "packages/tui/src/routes/home/session-destination.tsx": "6bd539d6ce6ece6bb0b5b94e186fe8b06ad06559fa97dae17ea52bf3f14ecc90",
  "packages/tui/src/routes/session/index.tsx": "bf7706ae0c8f1841cadf70aab74bd102ceae7d1597ba6f839f35cd073fbc17eb",
}

export const manifest = {
  ...base,
  version: "1.18.29",
  files: base.files.map((entry) => ({
    ...entry,
    beforeSha256: HOST_HASHES[entry.path] ?? entry.beforeSha256,
  })),
}

for (const entry of base.files) {
  if (!HOST_HASHES[entry.path]) {
    throw new Error(`OpenCode v1.18.29 profile is missing a verified fingerprint for ${entry.path}`)
  }
}
