# Triggeryze — User Guide

## Quick start guide

Triggeryze works by matching triggers (things the AI wrote) and running actions (things you want to happen). The fastest way to learn it is to build a simple rule.

## Quick Start: Build an Anti-Slop Filter in 2 Minutes

New to Triggeryze? Follow this example to automatically rewrite common AI writing clichés.

### Step 1: Create a rule

Click **+ Rule**.

### Step 2: Add a trigger

Click **+ Trigger**.

From the dropdown, select **Regex**.

Paste this regex:

```regex
\b(breath catch\w*|catch\w*\s+breath|breath hitch\w*|hitch\w*\s+breath|shak\w+\s+breath\w*|anchoring|tether|burgandy|ledger|claiming|stone\s+dropped\s+into\s+water|tell\s+me\s+what\s+you\s+want|doesn't\s+adjust)\b
```

This trigger fires whenever the AI uses one of the listed phrases.

### Step 3: Store the prohibited phrase list

Click **+ Action**.

Select **Compose Variable**.

**Variable name:**

```text
bad phrases
```

**Template:**

```text
breath catch
catch breath
breath hitch
hitch breath
shaky breath
anchoring
tether
burgandy
ledger
claiming
stone dropped into water
tell me what you want
doesn't adjust
```

### Step 4: Rewrite the paragraph

Click **+ Action** again.

Select **Call LLM**.

Configure:

* **Connection:** your preferred model
* **Output:** Replace paragraph

Paste the following prompt:

```text
The current paragraph broke a generation constraint by using the prohibited phrase "{{keyword}}".

Prohibited Phrase List for reference:
{{bad phrases}}

Task: Rewrite the immediate paragraph smoothly to completely remove "{{keyword}}", while strictly MAINTAINING the current tone of the story.

Requirements:
1. Aim for a minimal structural change to the paragraph.
2. Do not use a simple, lazy word-replacement cliché (e.g., if the keyword is "breath hitch", do not swap it for "breath caught", "gasped", or anything involving respiration). Completely change the physical action or internal reaction to avoid lazy writing tropes entirely.
3. Output ONLY the corrected paragraph text with no introductory remarks.

{{paragraph}}
```

### Result

Whenever the AI generates one of the prohibited phrases, Triggeryze automatically rewrites the affected paragraph and removes the cliché before the final message is displayed.

---

### What this rule is doing

This rule has one trigger and two actions:

#### Trigger: Regex

The regex scans every AI response for prohibited phrases such as:

* breath hitch
* anchoring
* tether
* ledger
* tell me what you want
* doesn't adjust

When one is found, the matched phrase becomes `{{keyword}}`.

For example, if the AI writes:

> Her breath hitched as he stepped closer.

Then:

```text
{{keyword}} = breath hitched
```

#### Action 1: Compose Variable

The compose variable action creates a variable named `bad phrases`.

This variable simply stores the full list of prohibited phrases so it can be referenced later in prompts.

```text
{{bad phrases}}
```

expands to the complete list you entered.

#### Action 2: Call LLM

The Call LLM action receives:

* the matched phrase (`{{keyword}}`)
* the prohibited phrase list (`{{bad phrases}}`)
* the paragraph containing the match (`{{paragraph}}`)

It then asks the model to rewrite only that paragraph while removing the prohibited phrase.

Because the output mode is **Replace paragraph**, the original paragraph is replaced with the rewritten version.

#### Example

Original:

> Her breath hitched as he reached for her hand.

The regex matches:

```text
breath hitched
```

The Call LLM action rewrites the paragraph.

Possible result:

> She froze for a moment as he reached for her hand, her attention narrowing to the space between them.

The rest of the message remains unchanged.


## Rules

A rule pairs one or more triggers with one or more actions. When the AI generates a response, Triggeryze evaluates every enabled rule. If the trigger conditions are met, the actions run.

Rules are evaluated in list order. Each rule fires at most once per stage per turn.

### Rule header controls

Each rule header exposes a row of controls:

| Control | Action |
|---|---|
| Checkbox | Enable or disable the rule without deleting it |
| Name field | Edit the rule's display name |
| DEV | Toggle dev mode for this rule — see [Dev mode](#dev-mode) |
| Export | Download the rule as a JSON file |
| Clone | Duplicate the rule and insert the copy immediately below |
| Collapse (chevron) | Collapse or expand the rule body |
| ✕ | Delete the rule |

The clone button creates an independent copy with a fresh ID. The copy's name gets " (copy)" appended. It behaves identically to any manually created rule and can be edited, moved, or deleted without affecting the original.

---

## Triggers

Triggers define when a rule fires. A rule can have one trigger or several, combined with AND or OR logic.

### Keyword match

Matches one or more words anywhere in the response. Keywords are comma-separated.

Wildcards are supported: `*` matches any number of characters, `?` matches exactly one. Enable the **case sensitive** toggle to require exact capitalisation — by default matching is case-insensitive.

Examples:

| Keyword | Matches |
|---|---|
| `dragon` | dragon, Dragon, DRAGON |
| `sam*` | sam, samuel, samurai |
| `el?ra` | elara, elora, elira |
| `fire, flame` | either word |

The matched word or phrase becomes `{{keyword}}` in action templates.

### Lorebook keyword

Fires when the response contains any primary trigger key from the currently active lorebooks. No configuration required — the lorebooks supply the keywords automatically.

Useful for detecting when the AI writes something that has a lorebook entry but may not have had that entry in context.

The matched key becomes `{{keyword}}`.

### Regex

Matches a regular expression against the response. Use SillyTavern's `/pattern/flags` syntax for full control, or enter a plain pattern without slashes for a basic match.

The full match (or first capture group, if the pattern uses captures) becomes `{{keyword}}`.

### Chat complete

Fires once after each AI message is fully received. During streaming it does not fire — only after the last token is committed. In non-streaming mode it fires immediately when the response arrives.

Designed for postMessage-stage actions (call LLM, replace, generate image). Pairing it with stream-stage actions (stop) has no effect because the stream is already over by the time this trigger becomes true.

`{{keyword}}` is set to `chat complete` when this trigger fires, though it is rarely needed in templates.

### Variable match

Fires when a named variable matches a condition. The variable must have been set by an action in an earlier rule during the same turn.

Configure a variable name, an operator, and a value to compare against:

| Operator | Fires when |
|---|---|
| equals | The variable's value is exactly the target string |
| contains | The variable's value contains the target string (case-insensitive) |
| matches regex | The variable's value matches the regular expression |
| not empty | The variable has any non-blank value |

The preview below the config shows the variable's current value from the last turn, so you can verify the upstream rule is producing what you expect.

If the variable has not been set this turn, the trigger does not fire and a warning is written to the browser console.

`{{keyword}}` is set to the variable's actual value when this trigger fires.

### Badge button

Adds a labeled, colored button next to the status badge on every AI message. The button does not fire during normal rule evaluation — it only fires when clicked.

**Label** — the text shown on the button.
**Color** — the button's accent color, applied to the border, background tint, and text.

`{{keyword}}` is set to the label text when the button is clicked.

`{{highlighted}}` is set to any text selected in the browser at the moment the button is clicked. If nothing is selected, it is an empty string. This lets you select a passage from the message before clicking, and have the rule act on the specific text — for example, selecting a character name to trigger a targeted lorebook write, or selecting a phrase to feed into a custom LLM prompt.

Use badge buttons for rules you want to run on demand rather than automatically: re-running an enrichment call on an older message, manually regenerating an image, or triggering a one-off classification.

### Combining triggers

When a rule has multiple triggers, the **any / all** selector at the top of the WHEN section controls how they combine:

- **any** (OR) — the rule fires if at least one trigger matches
- **all** (AND) — the rule fires only when every trigger matches simultaneously

---

## Actions

Actions define what happens when a rule fires. A rule can have one action or several. Actions run in the order they appear and can share data through variables.

Actions belong to one of two stages: **stream** (fires during active generation) or **postMessage** (fires after the full message is committed). See [When things fire](#when-things-fire) for detail.

### Stop

**Stage: stream**

Halts the AI response the moment the keyword is detected. The partial message is saved exactly as written — the keyword that triggered the stop is left in place.

To also remove the keyword, add a separate replace rule that matches the same keyword and leaves the replacement blank.

Requires streaming to be enabled.

### Stop + continue

**Stage: stream**

Stops the response and immediately resumes generation. The resumed response starts fresh from the stop point, with any lorebook entries the keyword would have activated now present in context.

Use this to inject lorebook context mid-response without manual intervention. Requires streaming.

### Replace

**Stage: postMessage**

Replaces every occurrence of the matched keyword in the finished message with a configured string. Leave the replacement blank to delete the keyword entirely.

The replacement is shown visually during streaming — the corrected text appears token by token rather than snapping in at the end. The authoritative rewrite still happens once the message is committed.

The replacement string supports template variables: `{{keyword}}`, `{{message}}`, and any variables set by earlier actions in the same rule.

### Call LLM

**Stage: postMessage**

Fires an LLM request when the rule matches and applies the result to the message.

**Connection** — which model to use. Defaults to the main ST chat LLM. If the Connection Manager extension is installed, any registered profile can be selected.

**Output** — what to do with the result:

| Mode | Effect |
|---|---|
| Replace keyword | Replaces every occurrence of the matched keyword with the result |
| Replace paragraph | Replaces the entire paragraph containing the keyword |
| Append to message | Adds the result at the end of the message |
| Insert as message | Inserts the result as a new AI message after the current one |
| Silent | Runs the call but discards the result (use with Save as to capture it in a variable) |

**Calls** — *Once* sends one request and uses the same result for every keyword instance. *Per match* sends an independent request for each occurrence, each with its own `{{up-to}}` context.

**History** — include N prior chat turns in the prompt as `{{history}}`.

**Save as** — store the result in a named variable. Later actions in the same rule can reference it as `{{variableName}}`.

**Prompt template** — the text sent to the LLM. Supports all template variables. See [Variables and templates](#variables-and-templates).

**Timing:** The LLM call fires as soon as the keyword appears in the stream, not after streaming ends. In most cases the result is already ready by the time the message is committed. Keywords with in-flight calls are shown with a faint amber highlight while the result is on its way.

**Note on same-paragraph conflicts:** If two separate rules both use replace paragraph mode and their keywords appear in the same paragraph, the first rule in the list wins. After it replaces the paragraph, the second rule's keyword is no longer present and that rule does not fire. To avoid this, combine both into a single rule with two call LLM actions.

### Compose variable

**Stage: postMessage**

Builds a named variable from a template without making any LLM call. The variable is available to all later actions in the same rule and is also published turn-wide, so a variable match trigger in a later rule can test it.

Use compose variable to classify or reshape the matched keyword before feeding it to a call LLM action — for example, mapping a keyword to a category label, or routing subsequent rules based on what the AI wrote.

The template supports the same variables and conditional blocks as all other template fields. See [Variables and templates](#variables-and-templates).

### Generate image

**Stage: postMessage**

Generates an image when the rule fires and attaches it to the message.

**Source** — which image backend to use. Supported cloud backends: Pollinations, FAL AI, Black Forest Labs, Stability AI, OpenAI, Google, Together AI, Chutes AI, Electron Hub, NanoGPT, xAI, Z AI, AIML API, OpenRouter, Hugging Face, and ComfyUI. Local backends (A1111, VLAD, SD.cpp, Draw Things, NovelAI, Extras, Horde) are not supported — choose a cloud source.

**Model** — the model to use. Auto-populated from the selected source's model list.

**History** — include N prior chat turns as `{{history}}` in the image prompt.

**Save as** — stores the uploaded image path in a named variable for use by later actions.

**Prompt template** — the image prompt. Supports all template variables.

**Persist in chat** — when enabled, the image is saved to the chat and reloads with it. When disabled, the image is shown in the current session but not written to the chat file and will not reappear after reload.

Image generation runs in the background and does not block the next message. If the user swipes before the image arrives, the result is discarded.

The **Test** button previews the image without attaching it to any message.

### Slash commands

**Stage: stream and postMessage**

Executes any SillyTavern slash command string when the rule fires. Template variables resolve before the command runs, so `{{keyword}}`, `{{message}}`, and any rule variables can be embedded directly in the command string.

The output of the last command in the chain (the "pipe" value) can be captured via **Save as** and used in later actions in the same rule, or tested by a variable match trigger in a subsequent rule.

**Fires at both stages.** A slash commands action evaluates during streaming AND after the message is committed. If your command reads `{{message}}` or calls `/send`, pair the rule with a chat complete trigger using all logic — this restricts the action to postMessage stage only. A warning note in the action UI flags this behavior.

SillyTavern's own error handling manages parse errors. Malformed or missing commands show ST's standard error output rather than stopping Triggeryze.

### Lorebook entry

**Stage: postMessage**

Creates or updates a lorebook entry. The lorebook file must already exist in SillyTavern's World Info panel.

**Lorebook** — the name of the lorebook file to write to.

**Title** — the entry's display name. Used to find existing entries for update. Supports template variables.

**Keys** — comma-separated trigger keywords. Optional. On update, new keys are merged into the existing key list rather than replacing it, preserving any manually-set keys.

**Content** — the entry body. Supports all template variables. Use `{{myVar}}` to feed the output of a call LLM action directly into the entry.

**Save as** — stores the entry title on success, for use by later actions.

If an entry with the given title already exists, its content is replaced and any new keys are merged in. If no matching entry is found, a new one is created with a full default schema.

After saving, the lorebook cache is refreshed so any `{{getLBcontent ...}}` token or lorebook keyword trigger in the same turn sees the updated data immediately.

**Power pattern:** call LLM (silent, save as `bio`) → lorebook entry with `{{bio}}` as content. The AI's response generates character data; the rule writes it to the lorebook in the same turn.

---

## Variables and templates

Variables carry data within a single rule execution. They are not shared between rules, and they reset at the start of each new rule firing.

### System variables

Available in every template field, in every action:

| Variable | Value |
|---|---|
| `{{keyword}}` | The matched keyword, regex capture, or trigger sentinel |
| `{{up-to}}` | All message text before the first keyword occurrence |
| `{{paragraph}}` | The paragraph containing the keyword |
| `{{message}}` | The full message text |
| `{{history}}` | Recent chat history, N turns (configured per action) |
| `{{char}}` | Character name |
| `{{user}}` | User name |
| `{{getLBcontent keyword}}` | Lorebook entry matching the trigger keyword — see [Lorebook lookup in templates](#lorebook-lookup-in-templates) |
| `{{getLBcontent highlighted}}` | Lorebook entry matching the selected text from a badge button click |
| `{{getLBcontent myVar}}` | Lorebook entry matching the value of rule variable `myVar` |
| `{{getLBcontent [Entry Name]}}` | Lorebook entry by literal title |
| `{{highlighted}}` | Text selected in the browser when a badge button was clicked; empty string for all other trigger types |

### Rule variables

Set by a compose variable or call LLM action (via the **Save as** field).

**Within a rule:** the variable is available to every action that follows. Set `Save as` to a name like `label` in an earlier action, then reference it as `{{label}}` in any later action's template within the same rule.

**Across rules:** rule variables are not directly accessible as `{{label}}` in other rules — each rule starts with a clean variable scope. What does carry across is the underlying value: after each action runs, its `Save as` value is written to a turn-level store. A variable match trigger in a later rule can read from that store. When it fires, the matched value becomes `{{keyword}}` in that rule's action templates.

Cross-rule data flow pattern:
1. Rule A action: `Save as` → `bio`
2. Rule B trigger: variable match on `bio`, operator not empty
3. Rule B fires → `{{keyword}}` = the value of `bio`

Triggeryze's stability loop re-evaluates rules after each firing, so rule A sets the variable in pass one and rule B's trigger sees it in pass two.

**Name clashes:** the turn-level store is a flat map — if two rules both use `Save as = result`, the second rule to run overwrites the first. Use distinct names per rule to avoid ambiguity.

Turn-level variables are cleared at the start of each new generation.

### Action ordering and dependencies

Actions run in order. If action B's prompt references a variable set by action A (`{{label}}`), B waits for A to finish before running. Independent actions that reference no shared variables run in parallel.

The dependency system is automatic — declare the variable name in the earlier action's **Save as** field. No extra configuration needed.

### Conditional blocks

Include text in a template only when a condition is true:

```
{{if condition}}text to include{{/if}}
```

Multiple blocks can be stacked. They cannot be nested.

**Condition operators:**

| Operator | Example | Matches when |
|---|---|---|
| `matches "pattern"` | `keyword matches "fire\|flame"` | Variable matches the regex (case-insensitive) |
| `contains "text"` | `keyword contains "blood"` | Variable contains the substring |
| `is "value"` | `keyword is "stone"` | Variable equals the value, whole-word |
| `in (a, b, c)` | `keyword in (red, blue, green)` | Variable equals any listed value |
| `empty` | `label empty` | Variable is blank, `none`, or `unspecified` |

**Boolean combinators** — precedence: `!` > `AND` > `OR`; use `()` to override:

```
{{if keyword matches "breath|hitch" AND mood is "tense"}}Forced Physical Reaction Cliché
{{/if}}
```

Variable names in conditions are bare — no `{{}}` around them.

---

## Lorebook lookup in templates

Any template field can embed a lorebook entry's content directly:

```
{{getLBcontent keyword}}
{{getLBcontent [Elara Voss]}}
{{getLBcontent MyLorebook:[Elara Voss]}}
```

**Entry name forms:**

| Form | Looks up |
|---|---|
| `keyword` | Entry whose title matches the matched keyword |
| `highlighted` | Entry whose title matches the text selected when a badge button was clicked |
| `myVar` | Entry whose title matches the value of rule variable `myVar` — any variable set by an earlier action can be used |
| `Elara Voss` | Literal entry name — brackets are optional, even for names with spaces |
| `[Elara Voss]` | Same; brackets are stripped and the name is used as-is |
| `MyLorebook:[Elara Voss]` | Literal name scoped to a specific lorebook |

Variable lookup happens after the sentinel check: if the name is not `keyword` or `highlighted`, the resolver checks whether a rule variable with that name exists and uses its value as the entry title. If no variable matches, the name is used literally. Brackets are never required — they exist only to visually distinguish entry names that contain colons, which would otherwise be parsed as lorebook prefixes.

Without a lorebook prefix, all active lorebooks are searched.

**Output format** — the token is replaced with:

```
Elara Voss:
(elara, voss, beth)
Senior archivist of the Conclave...
```

The entry title on the first line, keywords in parentheses (omitted if the entry has none), then the entry body.

If no matching entry is found, the token is replaced with an empty string and an error is written to the browser console.

---

## When things fire

Triggeryze operates at two distinct stages of the generation lifecycle:

| Stage | When | Actions available |
|---|---|---|
| **stream** | As each token arrives, before the message is committed | stop, stop + continue, slash commands |
| **postMessage** | After the full message is saved | replace, call LLM, compose variable, generate image, slash commands, lorebook entry |
| **manual** | When a badge button is clicked | all postMessage actions |

A rule can have actions at both stages. They fire at different moments in the same generation. A common pattern: a stop rule halts the stream on a sentinel keyword; a replace rule on the same keyword removes it from the saved message.

**Slash commands fires at both stages.** An action with `stage: ['stream', 'postMessage']` (as slash commands uses) runs once at stream time and again after the message is committed. Pair the rule with a chat complete trigger using all logic if you only want it to run postMessage.

Deduplication is per {rule, stage}. A rule with stream and postMessage actions fires once at stream stage and once at postMessage stage — they do not interfere with each other's dedup.

### Non-streaming mode

Enable **Run on non-streaming responses** in the settings panel. When active, stream-stage rules also evaluate after a non-streamed response arrives — the same point where postMessage rules run. In streaming mode they evaluate during the live stream as usual.

---

## Profiles

Rule sets can be saved to named profiles and swapped without losing work.

The profile bar appears at the top of the settings panel. An asterisk next to the profile name means the live rules differ from the saved snapshot.

| Button | Action |
|---|---|
| Save (disk icon) | Updates the current profile to match the live rules |
| New (+) | Saves a copy under a new name |
| Rename (pencil) | Renames the current profile |
| Delete (trash) | Removes the profile; the first remaining profile becomes active |
| Export | Downloads the current profile as a JSON file |
| Import | Loads a profile or individual rule from a JSON file |

Switching profiles replaces the live rules with that profile's snapshot. Unsaved changes to the current profile are lost.

---

## Status badges

A small pill appears below each AI message showing rule processing state:

| Badge | Meaning |
|---|---|
| Gray | No rules modified this message |
| Red pulse | A rule action is currently running |
| Green | At least one rule modified this message |

Clicking the status pill reruns all postMessage rules against that message using the current rule list. Use this to test rule changes or retry a failed action without sending a new message.

If any rule uses the **badge button** trigger, additional labeled buttons appear next to the status pill — one per rule. Clicking a labeled button fires only that specific rule against the message.

---

## Dev mode

Click the **DEV** button in a rule header to enable dev mode for that rule. When active, the rule logs full execution detail to the browser console:

- Every action's inputs, variable state before and after, and output
- Full LLM prompts and responses
- Dependency waits (which action is blocked waiting for which variable)

Dev mode is per-rule and persists in settings. Disable it when not actively debugging.

---

## Known behaviors

**Stop does not remove the keyword**
The stop action halts the stream and leaves the partial message exactly as written, keyword included. To also remove it, add a second rule that matches the same keyword and uses the replace action with a blank replacement. The two rules compose cleanly.

**Two call LLM (replace paragraph) rules on the same paragraph**
If two rules both use replace paragraph mode and their keywords appear in the same paragraph, the first rule in the list wins. After it replaces the paragraph the second rule's keyword is gone and that rule does not fire. Its prefetch LLM call is discarded silently. To prevent this, combine both replacements into one rule with two call LLM actions.

**Lorebook keyword reads primary keys only**
The lorebook keyword trigger scans primary trigger keys. Selective logic keys, secondary keys, and hidden keys are not included.

**Call LLM adds a background generation**
When a call LLM action runs, SillyTavern's generation state is briefly active again. This is expected. Triggeryze guards against this triggering a dedup reset, so rules continue to behave correctly.

**Chat complete and stream-stage actions**
The chat complete trigger only becomes true after the message is committed. Pairing it with stop or stop + continue has no effect — those actions require an active stream, which no longer exists at that point.

**Variable match with no upstream rule**
If a variable match trigger names a variable that was never set this turn, the trigger does not fire and a warning is written to the browser console. Check that the upstream rule is enabled, fires before the variable match rule in the list, and has its Save as field filled in with the matching name.

**Badge trigger and AND logic**
A badge trigger combined with other triggers using AND prevents the rule from auto-firing. The badge trigger's condition always evaluates to false during automatic rule scanning. Use OR logic if you want a rule that fires both automatically on a keyword match and manually on button click.

**Slash commands fires at stream and postMessage stages by default**
A slash commands action evaluates twice per turn: once during streaming and once after the message is committed. If your command assumes the message is fully written — reading `{{message}}`, using `/send`, or similar — pair the rule with a chat complete trigger using all logic. This constrains the rule to postMessage stage only, preventing the action from running against a partial message.

**Lorebook entry requires an existing lorebook file**
The lorebook entry action can create and update entries within a lorebook, but it cannot create the lorebook file itself. Create the lorebook in SillyTavern's World Info panel before referencing it in this action.

**Circular variable dependencies within a rule cause a hang**
If action A reads `{{y}}` (produced by action B) and action B reads `{{x}}` (produced by action A), neither action can start — each is waiting on the other's output. The rule hangs silently with no error or timeout. Within-rule dependency chains must be linear: A → B → C, never looping back.

Cross-rule cycles are safe. Each rule fires at most once per turn, so a loop of Rule A → Rule B → Rule A terminates after Rule A fires in the first pass — it is deduped out of all subsequent passes.
