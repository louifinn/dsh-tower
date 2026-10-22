// Best-effort temp-tree cleanup shared by the mount smoke and its fixtures (#91).
//
// Windows can hold a handle on a just-written file after a child process exits
// (EPERM/EBUSY). Cleanup is never part of a proof, so retry briefly and give up:
// a locked temp directory must not turn a green run red or hide the real cause
// of a red one.
import fs from 'node:fs'

export function removeTreeQuietly(dir) {
  if (!dir) return false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      return true
    } catch {
      // Still locked; try again, then leave the directory for the OS.
    }
  }
  return false
}
