# TRG Feature Test Methodology

## The Core Principle

Before building any production ruleset that depends on a TRG feature, build a minimal standalone test ruleset that proves the feature works exactly as expected. This is not optional — TRG has a non-trivial engine with subtle operator semantics, and assumptions that seem obvious often turn out to be wrong or masked by bugs.

The tests we built during the Location Tracker session caught:
- Three condition evaluator bugs (`=`, `!=`, `is empty` all broken)
- A cache coherence bug in lorebook writes
- `not-set` vs `not-empty` operator distinction
- `is empty` requiring the variable to exist vs `not-set` for variables never written

None of these would have been obvious from reading the syntax doc alone.

---

## When to Build a Test Ruleset

Build one whenever your production ruleset depends on:

- A variable operator you haven't verified (`empty`, `not-empty`, `set`, `not-set`, `=`, `!=`)
- A lorebook query pattern (`lbTitles`, `lbContent` with key filters, `inactive` scope)
- A condition expression against a chatvar or globalvar
- A cross-rule variable dependency (one rule sets a var, another reads it)
- Any feature you haven't used in a previous working ruleset

If you've already proven the feature in a prior session and the engine hasn't changed, skip it. Otherwise, test first.

---

## Structure of a Good Test Ruleset

### Self-contained
Each test rule is independent. No rule depends on another rule's output. If test 4 fails, tests 5–8 still tell you something useful.

### Badge-driven
Use badge triggers (`click: "fire"`) rather than `MESSAGE_RECEIVED` events where possible. This lets you fire tests on demand, in any order, without generating AI messages. For tests that must use `MESSAGE_RECEIVED` (condition triggers, var-match on turn variables), document clearly that they fire on the next AI message.

### Toast as output
Every test toasts its result directly. Use `{{default: (empty): {{var}}}}` so you can distinguish "returned empty string" from "variable was unset". Use different toast levels to make pass/fail visually obvious:
- `success` (green) — expected positive result
- `info` (blue) — neutral read-back
- `warning` (orange) — unexpected or fallback state
- `error` (red) — should not have fired

**Make the message self-describing.** When you're reading five toasts at once, you need to know what each one tested without looking at the ruleset. Format the message to show both the input and the output:

```
"tarvern" → Tavern [PASS]
"xyzzy" @99% → (empty) [PASS]
var=$fzt fuzzy "Tavern" 80 → FIRED
```

Use the toast **title** for the test name and the **message** body for the input → output line. Add a `[PASS]` suffix via an `{{if}}` block so the pass condition is machine-verified, not just eyeballed:

```jsonc
{
  "type": "toast",
  "level": "info",
  "title": "T2: typo match",
  "message": "\"tarvern\" → {{default:(empty):{{res}}}}{{if res is \"Tavern\"}} [PASS]{{/if}}"
}
```

For "should not fire" tests, use `error` level so they are visually unmistakable if they appear.

### Named clearly
Rule names follow the pattern `Test N: what it tests`. The toast title matches. When you're reading five toasts at once you need to know immediately which test produced which result.

### Write before read
If a test reads a value, a preceding test writes it. The write test toasts confirmation of the write. The read test toasts the value read back. These are separate tests — don't combine them.

---

## The Standard Test Patterns

### Variable write/read loop
```
Test 1: Write — set-var, toast "var = 'value'"
Test 2: Read — toast {{default: (unset): {{chatvar::var}}}}
Test 3: Overwrite — set-var new value, toast confirmation
         (then re-run Test 2 to confirm new value, not old)
```

### Operator verification
```
Test N:   Set var to known value (badge)
Test N+1: Condition = known value → toast "MATCH" (MESSAGE_RECEIVED)
Test N+2: Condition != known value → toast "DIFFERENT" (MESSAGE_RECEIVED)
Test N+3: Clear var (badge)
Test N+4: Condition is empty → toast "UNSET" (MESSAGE_RECEIVED)
```
Run in sequence. Each MESSAGE_RECEIVED fires all three condition tests simultaneously — the combination of which toasts appear tells you the operator behaviour.

### Lorebook query loop
```
Test 1: Write entry — update lorebook, toast written title (from var field)
Test 2: Read titles — lbTitles query, toast result
Test 3: Read content — lbContent query, toast result
Test 4: No-match — lbTitles for non-existent title, toast raw result
Test 5: Default on no-match — {{default: (empty): {{lbTitles...}}}}
Test 6: var-match empty on no-match result
Test 7: var-match not-empty on known entry
```

### Fuzzy match verification
```
Test 1: Exact match      — badge → compose res={{fuzzy:80:Candidates:Exact}} → toast "Exact → {{res}} [PASS if res=Exact]"
Test 2: Typo match       — badge → compose res={{fuzzy:80:Candidates:Typoo}} → toast "Typoo → {{res}} [PASS if res=Candidate]"
Test 3: Below threshold  — badge → compose res={{fuzzy:99:Candidates:Typoo}} → toast "Typoo@99 → {{default:(empty):{{res}}}} [PASS if empty]"
Test 4: var-match fuzzy  — MESSAGE_RECEIVED → compose $var=Typoo, var-match $var fuzzy Candidate 80 → toast "FIRED [PASS]"
Test 5: Should not fire  — MESSAGE_RECEIVED, var-match $var fuzzy Unrelated 90 → toast "FIRED — UNEXPECTED" (level: error)
Test 6: condition fuzzy  — badge writes chatvar, MESSAGE_RECEIVED + condition chatvar fuzzy "target" 80 → toast
```
Each test shows query input and resolved output in the message body. The `[PASS]` suffix is an `{{if}}` block — verified, not eyeballed.

### Cross-rule variable dependency
When rule A sets a variable and rule B reads it, test the timing:
```
Test 1: Rule that sets the var (badge or MESSAGE_RECEIVED)
Test 2: Rule that reads the var with var-match (MESSAGE_RECEIVED)
```
Fire both in the same turn. If Test 2 fails, the variable wasn't available when the trigger evaluated — you have a loop-pass timing issue.

---

## What to Record

For each test run, note:
- Which toasts appeared and which didn't
- Any console warnings (especially `varMatch: "X" not set this turn`)
- Whether the behaviour matched the syntax doc

If something doesn't match the doc, write a CC brief before continuing. Don't build the production ruleset on top of unverified behaviour.

---

## Naming Convention and Storage

Test rulesets live in `docs/ruleset-tests/` and use the suffix `-test` with a short feature name:

```
trg-math-test.json          — {{math:}} functions, ternary, rand/randint  [validated 2026-06-28]
trg-switch-preset-test.json — switch-preset action, global var persistence  [validated 2026-06-28]
trg-fuzzy-test.json         — {{fuzzy:}} transform, var-match fuzzy, condition fuzzy, keyword/badge fuzzy mode  [validated 2026-06-28]
trg-chatvar-test.json       — ST variable operators
trg-lb-test.json            — lorebook write/read
trg-lb-empty-test.json      — lorebook empty result handling
trg-stvar-test.json         — full ST variable suite
trg-if-test.json            — {{if}} block variable forms
trg-fuzzy-test.json         — {{fuzzy:}} transform, var-match fuzzy operator, condition fuzzy, keyword fuzzy mode
```

Keep them. They're reusable regression tests if the engine changes. When you run one and all toasts show [PASS], update its `validated` date in `traceability.yaml`.

---

## Known Gotchas

### Pipe `|` in slash-cmd message bodies
ST's slash command parser treats `|` as a pipe operator (chaining commands). If a `slash-cmd` action passes `/sendas name="X" [ Morning | 📍 Inn ]`, ST splits it at `|` and sends two commands: `/sendas name="X" [ Morning ` and `📍 Inn ]` (the second is not a valid command). The message is created without the 📍, so keyword patterns that match on it silently fail.

**Rule:** Never use `|` inside the message body of a `slash-cmd` that calls `/sendas` or any other pipe-sensitive ST command. Use `-` or another separator instead.

This is also a risk in production rulesets if any rule assembles a slash-cmd template that could produce `|` in the output — e.g., a compose result inserted into a slash-cmd command string.

### `compose` always writes the var — use `empty` not `not-set` to detect no-result
`compose` writes `vars[name] = result` unconditionally, even when the template resolves to `""`. So after a compose action runs, the var is always in `set` state. `var-match not-set` only fires if compose never ran at all (the rule that calls compose did not trigger this turn).

**Consequence:** to route on "did this transform return a value?", use `empty` / `not-empty`, not `not-set` / `set`. The classic case is fuzzy routing — `{{fuzzy:...}}` returns `""` on no-match, so the var is `set` to `""`. `not-set` never fires; `empty` does.

**Rule:** use `set` / `not-set` only to detect whether a rule ran at all. Use `empty` / `not-empty` to branch on the value that rule produced.

### `/sendas` name format
Use the named-parameter form: `/sendas name="CharName" message text`. Without `name="..."`, ST parses the first token as the name — so if `{{char}}` resolves to a multi-word name like "Merch prince", ST reads "Merch" as the name and "prince message text" as the message body, dropping the intended content.

---

## The Fast Path

For a new feature with a single unknown, you don't need a full suite. Three rules is enough:

1. **Write** — badge that sets up the state
2. **Read** — badge that reads it back and toasts the raw result
3. **Condition** — MESSAGE_RECEIVED that tests the operator you care about

If all three behave as expected, proceed to the production ruleset. If any fail, investigate before continuing.

---

## Checklist Before Commissioning

- [ ] Have I used this variable operator before in a working ruleset? If not, test it.
- [ ] Have I used this lorebook query pattern before? If not, test it.
- [ ] Does my production ruleset have any cross-rule var dependencies? If so, test the timing.
- [ ] Am I using `empty` / `not-empty`? Verify whether the variable needs to exist first.
- [ ] Am I using `not-set` for variables that keyword triggers might not write? Verify.
- [ ] Am I using fuzzy matching (transform, var-match, condition, keyword/badge mode)? Test each integration point separately — threshold sensitivity is not obvious.
- [ ] Has the TRG engine been updated since I last used this feature? If so, retest.