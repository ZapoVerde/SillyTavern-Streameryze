# Streameryze

**[WIP]**

Streameryze watches the AI's response as it arrives and fires an action when a keyword appears. Four action types are available: stop the generation, replace the keyword in the finished message, trigger a background LLM call, or automatically stop and continue when the AI writes something that would activate a lorebook entry.

Rules are configured in the Extensions panel. Each rule is paired with an action. Multiple rules can be active at once.

---

## Installation

1. Open SillyTavern and click the **Extensions** icon (the puzzle piece).
2. Click **Install extension**.
3. Paste the repository URL and click **Install just for me** or **Install for all users**.
4. Streameryze will appear in your extensions list. Enable it from the checkbox in the panel.

---

## How It Works

Every AI response is monitored as it streams in. When the accumulated text contains a matching keyword, the rule's action fires.

Deduplication is per rule within a single generation: if a keyword matches, that rule will not fire again until the next turn. The dedup state resets automatically when a new generation begins.

---

## Action Types

### lorebook stop

Watches the stream against every primary keyword in your currently active lorebooks. The moment the AI writes a word that would trigger a lorebook entry, the generation stops and a continue fires automatically. The lorebook entry is now active in the resumed reply — the AI gets the context it was missing.

No keyword field needed. The lorebook provides the keywords.

This action is useful when the AI starts writing something it has no lorebook context for yet. Rather than letting it invent details you will have to delete, the generation cuts at the trigger point and resumes with the entry injected.

Works only when streaming is enabled.

### stop

Halts the generation the moment the keyword is detected in the stream. The message is saved with whatever text was produced up to that point — the keyword will be visible in the output.

This action only works when SillyTavern's streaming mode is enabled. It has no effect in non-streaming mode.

To halt and remove the keyword, pair a `stop` rule with a `replace` rule on the same keyword with a blank replacement. Both will fire in the same turn: stop during the stream, replace after.

### replace

Waits for the generation to finish, then replaces every occurrence of the keyword in the final message with the configured replacement string. Leaving the replacement blank deletes the keyword.

Works in both streaming and non-streaming mode.

### side call

Fires after the generation completes when the keyword is present in the final message. Intended as an extension point for triggering a background LLM call in response to the keyword.

**This action is a stub.** It does nothing out of the box. To use it, implement the prompt builder and result handler in `doSideCall()` inside `index.js`.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| **Enable** | On | Enables or disables all Streameryze processing. When off, no rules fire. |
| **Verbose logging** | Off | Writes per-rule evaluation details to the browser console. |

### Rules

Each rule has:

| Field | Description |
|---|---|
| **Enable** (checkbox) | Whether this rule is active. Disabled rules are never evaluated. |
| **Keyword** | The string to search for. Case-sensitive, exact match. |
| **Action** | One of `lorebook stop`, `stop`, `replace`, or `side call`. |
| **Replacement** | Text to substitute in place of the keyword. Only shown for `replace` rules. Leave blank to delete the keyword. |

Rules are evaluated in list order. Use the trash button to delete a rule.

---

## Notes

- **lorebook stop and stop both require streaming to be enabled.** Neither action has any effect in non-streaming mode.
- **lorebook stop reads primary keys only.** Secondary (selective logic) keys are not scanned.
- **lorebook stop fires on the first matching keyword it finds per stream event.** If multiple lorebook keywords appear in the same chunk, the first match wins and the rest are ignored for that turn. If SillyTavern is configured for non-streaming responses, the stream is never active and the stop action cannot fire.
- **Keyword matching is case-sensitive.** `[STOP]` and `[stop]` are different keywords.
- **A stop rule leaves the keyword in the message.** If you want it removed, add a replace rule for the same keyword with a blank replacement.
- **replace rewrites the saved chat.** The change persists across reloads.
- **side call does nothing until implemented.** See `doSideCall()` in `index.js`.
