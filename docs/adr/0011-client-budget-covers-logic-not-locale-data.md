# ADR 0011: The client size budget ratchets logic, not translation data

- Status: accepted
- Date: 2026-11-18
- Ref: #F67 (follow-up to #71)

## Context

#71 replaced the 1,980-line `ui-bundle/client.js` with an entry plus nine
surface chunks, and pinned the split in `tests/ui-bundle.test.mjs`: every
`ui-bundle/*.js` file at most 400 lines, and the sum over all of them within
10% of 1,980 — a 1,782–2,178 band. The intent was structural: stop one file
regrowing into a monolith.

The 2.9.2 tree measures 2,177 lines, one line below the 2,178 ceiling:
`client.cards.js` 362, `client.denied.js` 145, `client.dock.js` 377,
`client.helpers.js` 277, `client.js` 313, `client.locales.js` 181,
`client.mode.js` 217, `client.overlay.js` 65, `client.styles.js` 152,
`client.toolview.js` 85, `index.js` 3.

`client.locales.js` is the bilingual catalogue: 133 keys, one
`[English, Chinese]` pair each, 181 lines of data (the chunk also carries the
fixed `fill`/`translate`/`seatT`/`toolLabel` helper tail). Copy has to grow
with every new client surface string, so the next UI sentence breaks a gate
whose only in-budget remedy is compressing code or comments — the opposite of
the copy goal. The gate cannot tell a new sentence from a new abstraction, so
two quantities that move for opposite reasons were being ratcheted together.

## Decision

1. The size ratchet measures client **logic**: the sum of `ui-bundle/*.js`
   excluding `ui-bundle/client.locales.js`, still within 90%–110% of the
   1,980-line #71 baseline (1,782–2,178). Today the logic total is 1,996.
2. The 400-line per-file rule still applies to every client file, **including**
   `client.locales.js`.
3. The shipped chunk list is unchanged: exactly the nine
   `client.<surface>.js` names the entry loads, with `client.locales.js` as the
   single dictionary chunk.
4. The catalogue gets deliberate **data guards** in the same test file:
   identical `en`/`zh` key sets; a floor of 133 keys and a ceiling of 260;
   every value a non-empty string of at most 240 characters (today's longest
   is 162, so the cap leaves ~48% headroom); and no executable construct
   (`function`, `=>`, `require(`, `import`) in the catalogue region of the
   chunk, so logic cannot hide in the exempted data file.

`scripts/check-components.mjs` keeps owning copy quality (glossary, config
keys, tool ids); these guards are about the catalogue's shape and size, and
load the chunk through the same `window.__ModuleLoader__` seam the Web client
and that gate already use.

## Consequences

- A new user-facing string no longer has to pay for itself by deleting code or
  comments. The catalogue can roughly double (260 keys) before the ceiling is
  revisited.
- Logic growth is still capped: 1,996 of the 2,178 ceiling leaves 182 lines —
  about half a surface — so a new surface is still a deliberate budget
  decision, which is what #71 meant.
- The 400-line rule still bounds every individual file, so the data chunk
  cannot silently become a second client; today it is 181 lines, under half
  the target.
- The guards catch the concrete ways a catalogue degrades: a key added in one
  language, an empty value, a pasted paragraph, and logic smuggled into the
  data chunk. They do not judge the copy itself — the #F22 copy gate does
  that.
- No loader, host or surface change: the same nine chunks ship, no new
  dependency, no config key, no state field.
- Residual risk: the helper tail (`fill`, `translate`, `seatT`, `toolLabel`)
  is executable and the guard intentionally stops before it. Adding logic
  there is still possible; the 400-line file cap and review remain the
  boundary. If that tail changes, the guard's marker has to be updated
  deliberately.
- Splitting the catalogue per language is not done here. The Client locale
  service registers both dictionaries under one namespace and the entry loads
  one chunk; a per-language split would change activation and add chunk
  requests without fixing the sum-based ratchet unless the data exemption
  happened anyway. It stays a future option if the ceiling is reached.

## Rejected alternatives

- **Widen the band to +12%** — raises the ceiling to 2,217, about 39 lines more
  than today's 2,178, less than a release of copy, and it raises the ceiling
  for logic too. The same collision returns a feature or two later with less
  signal, and data and logic stay mixed.
- **Keep the gate as it is (2,177/2,178)** — the next string forces code or
  comment compression, so the gate pushes against the copy goal and invites
  workarounds (longer lines, deleted context comments) instead of a budget
  decision. That is a failure by one line away from the limit.
- **Split `client.locales.js` per language now** — doubles the chunk
  registrations and loader requests, and needs language negotiation the
  current one-namespace registration does not have. It also would not relax
  the sum unless the data exemption happened in the same change; doing both at
  once is more risk than one release needs.
- **Exempt the whole bundle or drop the total budget** — loses #71: the split
  would no longer be held together and `client.js` could regrow unnoticed.
- **A per-key or per-language guard with no total** — bounds no logic growth
  and leaves a single file free to absorb everything the ratchet used to
  constrain.
