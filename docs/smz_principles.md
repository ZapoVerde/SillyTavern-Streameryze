# Streameryze — Project Principles
*Read before writing any code. Applies to every session.*

---

## What a Principle Is

**A principle is an enduring statement of design intent.** It says what must be true and why it matters — not how it is currently implemented. A principle should survive a complete rewrite: if you could achieve the same property by different means, the principle still holds.

**A principle is not:** a description of specific functions or file paths, a code recipe, a static analysis rule, or implementation documentation. When a principle references code by name, that code illustrates the principle in action — it is not the principle itself.

If you find yourself writing "call X" or "wrap in Y", move that detail into code comments or documentation. The principle captures the *why*.

---

## What Streameryze Is

Streameryze is a **composable rules engine**. Users build rules from trigger ingredients (WHEN) and action ingredients (DO). When a generation fires, each rule's triggers are evaluated against the stream text; if the conditions are met, the rule's actions execute.

It is not a content filter, a narrative manager, or a message editor. It does not decide what to do with content — the user's rule list does. The extension exists only to evaluate those rules and dispatch to the appropriate action handlers.

The engine is framework-first: triggers and actions live in registries. Adding a new trigger or action type means adding an entry to the appropriate registry. No other file changes.

---

## 1. The Rule List is the Only Source of Truth

Streameryze has no opinions about what keywords matter or what should happen when they appear. All behaviour is fully determined by the user's saved rule list.

A session with no rules must produce exactly the same chat as a session without Streameryze installed.

---

## 2. Disabling is Total

When Streameryze is disabled, it must be as if it is not installed. No rules fire. No messages are mutated. No generations are stopped. No LLM calls are triggered.

This is not a courtesy — it is a correctness requirement. A disabled extension that still acts is a bug.

---

## 3. Action Type Determines Generation Stage — These Are Not Interchangeable

The three action types are bound to distinct stages of the generation lifecycle, and this coupling is architectural, not incidental:

- **stop** must intercept the live stream. It has no meaning once the message is committed.
- **replace** and **sideCall** must wait for the final message. They cannot act on in-progress text because the message does not exist yet.

Each action type is valid only at the stage that makes it possible. Moving an action to a different stage to solve an edge case is wrong — fix the action, not its stage.

---

## 4. Deduplication is Per {Rule, Stage}, Not Per Keyword

Within a single generation, a given rule fires at most once per stage (stream or postMessage). Deduplication resets at the start of every new turn. Streameryze has no cross-turn memory.

The dedup key is `{ruleId}:{stage}`, not the matched keyword. This is deliberate: it allows a stop rule and a replace rule that share a trigger keyword to both fire in the same turn — stop at stream stage, replace at postMessage stage. A common idiom is "stop and strip" — halting the stream on a sentinel and then removing it from the saved message. Deduplication by keyword alone would silently break this.

---

## 5. Stop Does Not Clean Up After Itself

The stop action halts the stream and does nothing else. The partial message is left exactly as the host wrote it — keyword included. This is correct behaviour, not a deficiency.

Message cleanup is a separate concern handled by the replace action. Keeping them separate means each action does one thing and can be composed freely. A stop action that also mutated the message would be two responsibilities in one place.

If a user wants "stop and strip", they create two rules.

---

## 6. Replace Owns the Message Edit

When a replace action fires, it is the sole writer to that message's text for that keyword. It updates the stored message and uses the host's normal save-and-notify pipeline to persist the change and signal that the message has been updated.

Replace never bypasses the host's rendering layer. Code that patches the DOM directly is taking on a responsibility that belongs to ST and will break across ST updates.

---

## 7. The Lorebook Trigger Borrows Keywords, It Does Not Own Them

The lorebook keyword trigger reads keyword definitions from the active lorebooks at the start of each generation. It does not maintain its own keyword list, does not write to any lorebook, and does not influence which entries activate — it only observes.

The lorebook is the source of truth for what keywords matter. The lorebook trigger is a read-only consumer of that information. Any code that writes to a lorebook entry, changes an entry's enabled state, or influences WI scanning as a side effect of this trigger has broken this principle.

---

## 8. sideCall is an Extension Point, Not a Feature

The sideCall action is intentionally unimplemented. It marks the correct seam where a user-defined background LLM call belongs — after the final message is committed, triggered by a keyword match.

What "do something with the result" means cannot be prescribed. It is context-specific and belongs to whoever implements the call. Do not add a generic default. A sideCall that does the same thing for everyone is not a sideCall — it is a feature that was not designed.

---

## 9. Verbose Logging is the Diagnostic Protocol

Rules engines are opaque by default: when something does not fire — or fires unexpectedly — there is no visible trail. Verbose mode is the answer to "why did that happen?"

When verbose is enabled, every rule evaluation produces a log entry: what keyword was tested, whether it matched, what action was taken or skipped and why. This must be sufficient to reconstruct the full decision path from the log alone, without access to the source.

Verbose is off by default. Silent operation is correct operation when nothing is wrong.

---

## 10. The Three Kinds of Code

Every module in Streameryze belongs to exactly one of three categories. Mixing them is a defect.

1. **Registry entries** — each trigger or action does exactly one thing. Triggers read text and return a match or null. Actions produce one side effect. No cross-entry logic lives in either registry.
2. **Engine** — evaluates the rule list and dispatches to registry entries. Decides *when* to act; registries decide *how*. Owns no business logic beyond matching and dedup.
3. **Entry point** — wires events to the engine and renders the settings panel. The panel is UI scaffolding: it reads settings into the DOM and writes DOM values back to settings. It contains no rule evaluation.
