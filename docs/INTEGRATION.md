# Integration (run only after all three sections are done)

The three sections are built by their owners on their own branches. Fable 5 is used **only at the end**,
as project manager and lead developer, to combine them. It does not build the sections.

## When to run it
Every box below is ticked by the section owner:
- [ ] A — `section/a-hook-steam`: every task in `docs/sections/A-game-hook-and-steam.md` done, tests pass
- [ ] B — `section/b-core-ai`: every task in `docs/sections/B-app-core-and-ai.md` done, tests pass
- [ ] C — `section/c-ui-demo`: every task in `docs/sections/C-ui-and-demo.md` done, tests pass

## Fable's job (and its limits)
1. Branch `integrate` from `main`; merge A, then B, then C with `--no-ff`.
2. Resolve merge conflicts and contract mismatches (wrong IPC names, JSON shape drift, port numbers,
   missing `preload.js` wiring) so the three parts run as one app. Small glue code is fine.
3. Run `npm install` and `npm test`; fix integration bugs only.
4. Write `docs/STATUS.md`: what works end to end, what's unverified, what to test on a real Windows machine.
5. **Do not build missing features.** If a section task isn't done, list it in STATUS.md and tell
   the owner. Don't write it yourself.
6. Fast-forward `main` to `integrate` and push. Never force-push.

## Prompt to give Fable (Claude Code, model: Fable 5)
> You are project manager and lead developer for dubplay. Read CLAUDE.md and docs/INTEGRATION.md.
> All three section branches are finished. Combine them per docs/INTEGRATION.md: merge, fix conflicts
> and contract mismatches, get `npm test` passing, write docs/STATUS.md, and push to main. Do not
> implement unfinished section tasks; report them instead.
