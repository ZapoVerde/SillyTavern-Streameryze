# Streameryze

**[WIP]**

Streameryze watches the AI's response as it arrives and fires actions when keywords appear. It can stop the response, replace text, or trigger background LLM calls and weave the results back into the message.

---

## Installation

1. Open SillyTavern and click the **Extensions** icon (puzzle piece).
2. Click **Install extension**.
3. Paste the repository URL and confirm.
4. Streameryze appears in the extensions list. Enable it from its settings panel.

---

## How It Works

Rules are made of triggers and actions.

**Triggers** define when the rule fires: a keyword, a lorebook entry, or a regex pattern. Multiple triggers can be combined with AND or OR logic.

**Actions** define what happens when the rule fires. Multiple actions can be stacked on one rule.

Each rule fires at most once per AI turn. Dedup resets automatically when a new generation starts.

---

## Triggers

### Keyword match

Matches one or more words in the AI's response. Keywords are comma-separated. Wildcards are supported: `*` matches any number of characters, `?` matches exactly one. Case-sensitive matching is optional.

Examples: `sam*, el?ra` matches `samurai`, `samuel`, `elara`, `elora`.

### Lorebook keyword

Fires when the AI writes any primary keyword from the currently active lorebooks. No configuration needed — the lorebooks provide the keywords.

Useful for detecting when the AI starts writing something it has no lorebook context for yet.

### Regex

Matches a regular expression against the response. Supports SillyTavern's `/pattern/flags` syntax.

### Trigger logic

When a rule has multiple triggers, choose whether **any** (OR) or **all** (AND) must match before the rule fires.

---

## Actions

### Stop

Halts the AI response the moment the keyword is detected. The response is saved with whatever was produced up to that point.

Requires streaming to be enabled.

### Stop + continue

Stops the response and immediately continues the generation. The new response starts after the stop point, with any lorebook entries the stopped keyword would have activated now present in context.

Useful for injecting lorebook context mid-response without manual intervention. Requires streaming.

### Replace

Replaces every occurrence of the keyword in the finished message with a configured string. Leave the replacement blank to delete the keyword. Works in both streaming and non-streaming mode.

The replacement is shown visually during streaming. The corrected text appears as it arrives, not after.

### Call LLM

Fires an LLM request when the keyword appears and applies the result to the message.

**Connection** — which LLM to use. Defaults to the main ST chat model. If the Connection Manager extension is installed, any registered profile can be selected instead.

**Output** — what to do with the result:
- *Replace keyword* — swaps every instance of the keyword with the LLM's response
- *Append to message* — adds the response at the end of the AI's message
- *Insert as message* — inserts the response as a new AI message after the current one
- *Silent* — runs the call but discards the result

**Calls** — *Once* sends one request and uses the same result for every keyword instance. *Per match* sends one independent request per occurrence.

**Prompt template** — the prompt sent to the LLM. Supports `{{keyword}}`, `{{message}}`, `{{char}}`, and `{{user}}` placeholders.

The LLM call starts as soon as the keyword appears in the stream rather than waiting for the response to finish. Keywords with in-flight calls are shown with a faint amber highlight while the result is on its way. By the time streaming ends, the result is usually already ready.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| **Enable** | On | Enables or disables all Streameryze rules. When off, nothing fires. |
| **Verbose logging** | Off | Writes rule evaluation details to the browser console. |
| **Run on non-streaming responses** | Off | Also evaluates stream-type rules against non-streamed responses. |
| **Show status badges** | On | Adds a small pill below each AI message showing whether Streameryze modified it. |

---

## Notes

- **Stop and Stop + continue require streaming.** Neither fires in non-streaming mode.
- **Lorebook keyword reads primary keys only.** Selective and secondary logic keys are not scanned.
- **Keyword matching is case-insensitive by default.** Enable the case-sensitive toggle in the keyword match trigger to change this.
- **Replace rewrites the saved chat.** The change persists across reloads.
- **Each rule fires at most once per turn.** If the keyword appears multiple times, the rule fires once. The Call LLM action's *per match* mode controls how many LLM calls happen within that single firing.
