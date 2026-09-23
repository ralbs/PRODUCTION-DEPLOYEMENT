# AQMS — repo root

Three services, kept deliberately separate — not merged into one folder.

```
frontend/   Next.js/React (Vercel) — the public dashboard, aqms-flame.vercel.app
backend/    Node/Express (Render) — ingest API + Mongo, real ESP32 devices report here
ctm-core/   Python — CTM, adjoint tracer, source inversion. Has its own
            detailed CLAUDE.md — read it in full before touching this
            folder, don't rely on it auto-loading (Claude Code's
            subdirectory memory loading has been reported unreliable).
```

## Deployment context — real, not hypothetical

This is a migration from a deployment under a different GitHub account to
this one. Real consequences of that, worth remembering throughout:

- **Real physical ESP32 devices are deployed and reporting.** Any change
  to the backend's URL or auth requires reflashing devices — never assume
  a "redeploy" is free. Reflash and verify ONE device before touching any
  others; the old deployment stays live as a fallback the whole time.
- **The current MongoDB has real (partial) historical data** worth
  preserving — a migration step should move it, not silently start from
  an empty database.
- Any credential/secret work (DEVICE_KEYS, MONGO_URI, etc.) needs fresh
  values under the new accounts — nothing transfers automatically from
  an account you don't control.

See PROMPT_FLOW_INTEGRATION.md's Phase I1 for the exact sequence.

## The confidence-treatment principle — applies to every CTM-derived value, everywhere

Every value that comes from the CTM (direction estimate, Q-estimate,
later the field view) gets three things, shown the same way every time,
not invented fresh per screen:

1. The value itself.
2. A confidence treatment that's STRUCTURAL — a visually distinct
   card/border/icon state for "estimated" vs "measured" — not a caption
   underneath a normal-looking number. Captions get skimmed past.
3. A staleness indicator relative to the data's actual age (the 2-hour
   cadence means "updated 47 min ago, next in ~1h 13m" is meaningfully
   different information than a bare timestamp).

If any route, DB write, or UI component drops this treatment to simplify
a response shape or save screen space, that's a bug — same severity as a
unit-conversion or sign error in the CTM itself.

## The ambient-data principle — applies to all future UI work, everywhere

CTM-derived data should drive ambient, persistent visual elements of the
interface, not be confined only to isolated widget cards. Real wind
speed and direction shaping a background element is the canonical
example — the interface's visual identity should come from having a
real, live physics model behind it, not from a generic dashboard
template with data trapped in boxes.

This is a standing rule for all future UI work, not scoped to any one
phase or document (it originates from, but is not limited to, the
phases described in `PROMPT_FLOW_UI.md`). If a new screen or component
puts CTM-derived data in a card when an ambient/persistent treatment
was reasonably available instead, that's a design regression worth
raising, at the same level as dropping the confidence-treatment
principle above.

## What's being built

Directional screening + single-zone emission-rate estimation feeding the
existing plume view (PROMPT_FLOW_INTEGRATION.md), and a UI redesign that
builds the confidence-treatment pattern in from the start rather than
retrofitting it (PROMPT_FLOW_UI.md). PROMPT_FLOW_PRODUCTION.md is the
separate, larger, not-currently-in-scope full-model validation program —
don't pull that work in here without a deliberate decision to do so.
