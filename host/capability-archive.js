// tower-archive component entry (#135): terminal-mission archival only.
//
// Archival used to be the `archive.enabled` tuning boolean. It is a capability —
// off means terminal missions stay hot in state.json — so it is its own row and
// its own switch. The row owns no tool: the sweep runs after mutations and asks
// this registry whether the row is mounted. Off means the hot state keeps
// growing; merges, gates and every other capability keep working and nothing is
// deleted. `archive.afterDays` / `archive.maxMissions` stay genuine tuning.
//
// The row is declared in cordis.patch.yml; the package export is `./archive`.
import { holdComponent } from './capability-registry.js'

export const name = 'dsh-tower/archive'
export const inject = ['tower']

export function apply(ctx) {
  holdComponent(ctx, 'tower-archive')
}
