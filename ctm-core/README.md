# Reduced Eulerian CTM + Adjoint Inverse Layer + Co-Kriging

Start here:
1. Read `CLAUDE.md` — the full physics/architecture spec and every known
   pitfall from prior development, in one place. Claude Code reads this
   automatically; you should read it once too before running anything.
2. Follow `PROMPT_FLOW.md` — a sequenced set of prompts for Claude Code
   CLI, phase by phase, each with explicit acceptance criteria. Run them
   in order; don't start phase N+1 until phase N's tests are shown passing.
3. `cities/` holds the per-city configuration system — `bangalore.json` and
   `template.json` are two deliberately different example cities used to
   prove the abstraction is genuinely portable, not secretly hardcoded.

Run `bash scripts/run_all_tests.sh` at any point to check the current state
of the suite.

## Scope

Forward reduced CTM (transport only, no chemistry) + true inverse source
estimation (observations -> emission strengths, not just attribution given
a known inventory) + co-kriging spatial interpolation (uncertainty-
quantified concentration maps using the CTM as trend, kriging the
residual). Not a regulatory-grade (CMAQ-class) model — say so wherever
attribution or inversion output is shown to a user.

A green test suite proves internal consistency. It does not prove the
model matches reality — that needs a real hindcast against observed data,
which is explicitly still open (see PROMPT_FLOW.md Phase 10).
