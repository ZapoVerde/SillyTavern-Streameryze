# Automated Ruleset Checks (Dev Harness)

This is a second way to verify ruleset behavior, alongside the manual methodology in
[test-ruleset.md](test-ruleset.md). They solve different problems — read "Which one do
I want?" below before picking one.

## Which one do I want?

**[test-ruleset.md](test-ruleset.md)** — build a small ruleset, load it into a real
SillyTavern, click badges, read toasts. No repo checkout or Node needed beyond the
extension itself. This is the default: use it to verify a feature works the way you
think it does *before* you build a production ruleset on top of it.

**This harness** — drive an *existing* ruleset JSON through the real engine code
(`evaluateTriggers`, `executeActions`, `rule-registry.js`'s reactive dispatch) headlessly,
in Node, via Vitest. Only the SillyTavern boundary is faked; every line of engine,
trigger, and action code that runs in production also runs here. Reach for this when:

- You suspect a **timing/race bug** — same-rule sibling actions firing in an unexpected
  order, a rule waking up before the variable it depends on has actually landed. Toasts
  in a live chat show you the *outcome* of a race, not the race itself; the harness lets
  you control exactly how fast a mocked async lookup resolves relative to its siblings
  and observe the sequence directly (`console.log` on turn vars, captured slash-command
  strings, etc.), which is what actually diagnosed the Location Tracker bug this doc's
  first example came from.
- You want a **repeatable regression check** for a specific example ruleset after
  touching engine code it depends on (condition evaluator, `getVarDeps` sequencing,
  lorebook query scope, and so on) — something you can re-run in seconds instead of
  re-triggering AI messages in a live chat.
- You need to simulate a **specific ordering of async events** (an LLM call resolving
  slower than a lorebook query, or vice versa) that's impractical to force reliably by
  hand in a real chat.

If you're validating a feature you're about to *use* for the first time, start with
test-ruleset.md — it requires nothing but ST itself and is the faster loop for that job.
Reach for this harness when you're debugging *why* something already misbehaved, or when
you're deep enough into engine internals that stepping through real code beats guessing
from toast output.

## Why these checks are not part of `npm test`

Example rulesets under `docs/examples/` are documentation content, not engine code —
they can change independently of it, and shouldn't gate the default test run the way an
engine regression test does. `docs/ruleset-tests/*.check.js` files are deliberately named
so Vitest's default include glob (`*.test.js` / `*.spec.js`) skips them. Run them
explicitly:

```
npm run test:rulesets
```

Engine-level regressions (a bug in the trigger/action code itself, not in an example's
JSON) still belong in `tests/*.test.js` against small synthetic rules, per Principle 15
in `trg_principles.md` — write one there first if the bug is in the engine rather than
in how a specific example ruleset is put together.

## How it's built

- **`tests/ruleset-harness.js`** — the reusable, mock-free half: an in-memory lorebook
  store, a minimal `stCtx` factory, `loadRulesetFromFile()` (JSONC-strip + `importRuleset`),
  and `simulateTurn()` (streams text, commits the message, raises `MESSAGE_RECEIVED`,
  then waits for async actions to settle — mirroring `engine.js`'s real event sequence
  closely enough for `rule-registry.js`'s reactive dispatch to behave the same way).
- **`docs/ruleset-tests/<name>.check.js`** — one file per ruleset under test. Vitest hoists
  `vi.mock()` calls per file at transform time, so these calls cannot live in the shared
  harness module — each check file declares its own ST-boundary mocks (`script.js`,
  `scripts/world-info.js`, `scripts/variables.js`, `actions/index.js`, `actions/dispatch.js`,
  etc.), then imports the reusable pieces from `tests/ruleset-harness.js`.
  `docs/ruleset-tests/location-tracker.check.js` is the reference example — copy its mock
  block for a new check file targeting a different example ruleset.
- **`vitest.rulesets.config.js`** — a separate Vitest config (not merged into the default
  `test.include`) that only picks up `docs/ruleset-tests/**/*.check.js`. It reuses the
  same `resolve.alias` entries as the base config (`tests/__mocks__/*.js` stubs for
  `script.js`, `scripts/world-info.js`, `scripts/variables.js`, `extensions.js`,
  `scripts/itemized-prompts.js`, `shared.js`) so ST-boundary imports resolve consistently
  regardless of how deep the importing file sits in the directory tree.

## Writing a new check

1. Copy the mock block from `docs/ruleset-tests/location-tracker.check.js` into a new
   `docs/ruleset-tests/<name>.check.js`.
2. Register only the action types your target ruleset actually uses in `ACTION_REGISTRY`
   (see the `Object.assign(ACTION_REGISTRY, {...})` line) — this avoids needing to mock
   every other action's ST dependencies.
3. Use `loadRulesetFromFile()` to import the real file under `docs/examples/`, not a copy —
   the check should always track the live doc.
4. Use `simulateTurn()` to drive one turn; assert on `getTurnVar(...)` and on the
   `executeSlashCommandsWithOptions` calls captured by your `stCtx`.
5. Run `npm run test:rulesets` to confirm both the new check and the existing ones pass.
