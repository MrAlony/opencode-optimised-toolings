import { promises as fs } from "node:fs"
import { sha256File } from "./state.js"

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Install the patched binary over the official OpenCode binary, in place.
 *
 * The official executable is replaced on disk while running instances keep
 * their already-mapped image, so no process is ever stopped, killed, or
 * restarted: the file is swapped exactly like a package update, and the user
 * restarts OpenCode at their convenience to activate it. The original
 * official binary is preserved once under `<official>.toolings-backup` for
 * restore.
 *
 * Windows refuses to overwrite (or copy onto) an executable image that a
 * running process has mapped (EBUSY), but it permits RENAMING such a file
 * away, because the image section keeps its own handle. So the swap is:
 * rename the mapped official image aside, copy the patched binary to the now
 * free official name, verify the fingerprint, and roll back on failure.
 *
 * Returns { installed, alreadyPatched, officialSha, patchedSha, backupPath }.
 */
export async function installPatchedBinary({ officialPath, patchedPath }) {
  if (!(await exists(officialPath)) || !(await exists(patchedPath))) {
    throw new Error("install-patched requires both the official and the patched binary")
  }
  const officialSha = await sha256File(officialPath)
  const patchedSha = await sha256File(patchedPath)
  if (officialSha === patchedSha) {
    return { installed: false, alreadyPatched: true, officialSha, patchedSha, backupPath: null }
  }
  const backupPath = `${officialPath}.toolings-backup`
  if (!(await exists(backupPath))) {
    await fs.copyFile(officialPath, backupPath)
  }
  const stash = `${officialPath}.toolings-incoming-${Date.now()}`
  await fs.rename(officialPath, stash)
  try {
    await fs.copyFile(patchedPath, officialPath)
  } catch (error) {
    await fs.rename(stash, officialPath).catch(() => {})
    throw error
  }
  const after = await sha256File(officialPath)
  if (after !== patchedSha) {
    await fs.rename(stash, officialPath).catch(() => {})
    throw new Error(
      `patched binary install failed: post-swap fingerprint mismatch (${after.slice(0, 12)} != ${patchedSha.slice(0, 12)})`
    )
  }
  // Best-effort cleanup: a running instance may keep the stashed image mapped,
  // in which case the deletion is deferred by Windows and harmless to ignore.
  await fs.rm(stash, { force: true }).catch(() => {})
  return { installed: true, alreadyPatched: false, officialSha, patchedSha, backupPath }
}
