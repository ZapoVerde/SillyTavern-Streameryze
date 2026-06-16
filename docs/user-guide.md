# Triggeryze — User Guide

## Quick start guide

Triggeryze works by matching triggers (things the AI wrote) and running actions (things you want to happen). The fastest way to learn it is to build a simple rule.

## Quick Start: Build an Anti-Slop Filter in 2 Minutes

New to Triggeryze? Follow this example to automatically rewrite common AI writing clichés.

### Step 1: Create a rule

Click **Add group** to create a new rule group, then click **+ rule** inside it.

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


## Groups

Rules are organized into named groups. Groups are purely organizational — the engine's fixed-point loop resolves variable dependencies across all groups regardless of arrangement, so groups can be freely rearranged without affecting how rules interact.

Click **Add group** to create a new group. Newly created groups appear below the existing ones.

A disabled group removes all its rules from engine consideration for the turn, identical to disabling each rule individually.

### Group controls

Each group header has a row of controls:

| Control | Action |
|---|---|
| Collapse (chevron) | Collapse or expand the group body |
| Checkbox | Enable or disable all rules in the group at once |
| Name field | Edit the group's display name |
| Export | Download the group and all its rules as a JSON file |
| ✕ | Delete the group and all its rules |

### Adding rules

Click **+ rule** inside a group to add a new rule to that group.

---

## Rules

A rule pairs one or more triggers with one or more actions. When the AI generates a response, Triggeryze evaluates every enabled rule. If the trigger conditions are met, the actions run.

Rules are evaluated in list order. Each rule fires at most once per stage per turn.

### Rule header controls

Each rule header exposes a row of controls:

| Control | Action |
|---|---|
| Drag handle (⠿) | Drag to reorder this rule within its group or move it to a different group |
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

**Variables and LB queries in the keywords field.** The keywords field resolves turn variables and lorebook query tokens before matching. This means you can use any of the following as a keyword source:

- `{{myVar}}` — expands to the comma-separated value of a turn variable set by a rule earlier this turn
- `{{lbTitles}}` — expands to a comma-separated list of all active lorebook entry titles
- `{{lbKeys:[MyLorebook]}}` — all trigger keys from a specific lorebook

These can be mixed with literal keywords: `dragon, {{lbTitles:[Creatures]}}` matches the word "dragon" or any creature lorebook title.

If a variable is not set this turn, it expands to nothing and contributes no keywords. The preview below the field shows the resolved list so you can verify the expansion before the turn runs.

### Lorebook keyword

Fires when the response contains any primary trigger key from the currently active lorebooks. No configuration required — the lorebooks supply the keywords automatically.

Useful for detecting when the AI writes something that has a lorebook entry but may not have had that entry in context.

The matched key becomes `{{keyword}}`.

### Regex

Matches a regular expression against the response. Use SillyTavern's `/pattern/flags` syntax for full control, or enter a plain pattern without slashes for a basic match.

The full match (or first capture group, if the pattern uses captures) becomes `{{keyword}}`.

### Event

Fires when a specific SillyTavern lifecycle event occurs. Choose the event from the dropdown.

**chat complete** — fires once after each AI message is fully received. During streaming it does not fire — only after the last token is committed. In non-streaming mode it fires immediately when the response arrives. Designed for postMessage-stage actions (call LLM, replace, generate image, compose variable). `{{keyword}}` is set to `MESSAGE_RECEIVED`.

**generation started** — fires at the very beginning of a new AI turn, before any tokens arrive. Use this to clear or reset variables at the start of each turn, prepare state, or run slash commands that need to execute before the response begins. `{{keyword}}` is set to `GENERATION_STARTED`. Common pattern: a generation started rule with a slash command action that clears a SillyTavern variable used to accumulate options across turns.

**message rendered** — fires each time a message is rendered to the DOM. This includes on chat reload, which means it may fire for every message in the chat when the page loads. Use with care and consider adding a condition trigger (using AND logic) to limit execution to specific circumstances. `{{keyword}}` is set to `CHARACTER_MESSAGE_RENDERED`.

### Variable match

Fires when a named variable matches a condition. The variable must have been set by an action in an earlier rule during the same turn.

Configure a variable name, an operator, and a value to compare against:

| Operator | Fires when |
|---|---|
| equals | The variable's value is exactly the target string |
| not equals | The variable's value is not exactly the target string |
| contains | The variable's value contains the target string (case-insensitive) |
| matches regex | The variable's value matches the regular expression |
| not empty | The variable has any non-blank value |
| is set | The variable exists this turn, regardless of value |
| is not set | The variable does not exist this turn |

The preview below the config shows the variable's current value from the last turn, so you can verify the upstream rule is producing what you expect.

If the variable has not been set this turn, the trigger does not fire and a warning is written to the browser console.

`{{keyword}}` is set to the variable's actual value when this trigger fires.

### Condition

Fires when a boolean expression over ST variables evaluates to true. Use this to gate any rule on game state without needing a dedicated variable match trigger for each individual comparison.

Write the expression in the text field using the following syntax:

**Variable prefixes:**
- `chatvar::name` — reads a chat-scoped (local) SillyTavern variable
- `globalvar::name` — reads a global SillyTavern variable
- bare `name` — reads a turn variable set by an earlier rule this turn

**Operators:** `< > <= >= = != matches contains is empty in (…)`

**Combinators:** `AND OR !` and `( )` for grouping

Examples:

```
chatvar::stats.hp < 20
chatvar::gold >= 100 AND chatvar::stats.hp > 0
globalvar::questPhase = "2" OR globalvar::questPhase = "3"
!(chatvar::inventory contains "sword")
chatvar::class in (warrior, paladin, ranger)
```

Combine with other triggers using AND logic to add a probability or keyword gate on top of a state check.

### Probability

Fires with the given probability each generation. Set **chance** to a number from 0 to 100; the default is 50.

Use this on its own for a rule that fires half the time, or combine it with other triggers using AND logic to make any existing rule probabilistic — for example, a keyword match that only acts on 30% of matches.

A chance of 0 never fires; a chance of 100 always fires.

### Badge

Adds a clickable button to an AI message. The badge does not fire during normal rule evaluation — it only fires when clicked. Three placement styles are available.

**Style: top** — adds a labeled, colored button next to the status badge near the message header. Use this for on-demand actions: re-running an enrichment call on an older message, manually regenerating an image, or triggering a one-off classification.

**Style: bottom** — adds labeled, colored buttons below the message text, stacked vertically. Use this for LLM-generated continuation options: a first rule with an event trigger (chat complete) calls the LLM to generate a list of options stored in a variable; a second rule with a bottom badge trigger and `{{myVar}}` as the label field + `\n` in the split field renders one clickable badge per option. Clicking an option injects or sends it.

**Style: inline** — wraps every occurrence of a keyword directly inside the rendered message text as a clickable colored span. The matched word itself becomes the badge. Use inline badges for concepts you want to be able to drill into: character names, locations, status effects.

---

**Common config (top and bottom styles):**

**Label** — the text shown on the button. Supports `{{varName}}` interpolation from turn variables.

**Color** — the button's accent color. Supports `{{varName}}` interpolation.

**Split** — if set, the resolved label is split on this character sequence and one badge is rendered per piece. Enter `\n` to split on newlines, `,` to split on commas, or any literal string. Leave empty for a single badge. This is the mechanism for producing multiple badges from a single LLM response stored in a variable.

**Click action** — what happens when the button is clicked:
- **fire rule actions** — runs the rule's action list, with `{{keyword}}` set to the badge label
- **inject to input** — pastes the badge label into the ST message input box without sending
- **inject and send** — pastes the label into the input box and submits immediately

---

**Inline style config:**

**Keywords** — comma-separated keywords to highlight. The same wildcard syntax as keyword match applies (`*`, `?`). Keywords support `{{varName}}` interpolation and lorebook query tokens — see [Variables and LB queries in the keywords field](#keyword-match).

**Color** — the accent color for spans. Supports `{{varName}}` interpolation.

**Click action** — same options as above. When **fire rule actions** is chosen, `{{keyword}}` is set to the exact matched text.

---

**Variables in badge fields.** All user-facing text fields on a badge trigger — label, color, keywords — resolve `{{varName}}` tokens against the current turn's variable store before rendering. This is how a rule that stores LLM output in `{{opts}}` can feed it directly to a bottom badge's label field.

**`{{highlighted}}`** is set to any text selected in the browser at the moment a top or bottom badge button is clicked. If nothing is selected, it is an empty string. Useful for selecting a passage before clicking, so the rule acts on the specific selection.

**Inline badge lifecycle.** Inline spans exist only on the current turn's message. At the start of each new generation, all spans are stripped from all messages. Badges are injected once when the response finishes; during streaming they are applied progressively. Historical messages do not carry inline badges.

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

Enable the **and continue** checkbox to resume generation immediately after stopping. The resumed response starts fresh from the stop point, with any lorebook entries the keyword activated now present in context. Use this to inject lorebook context mid-response without manual intervention.

Requires streaming to be enabled.

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

**History** — use `{{history:[N]}}` anywhere in the prompt to include the last N turn-pairs of chat history. N can be a literal in brackets (`{{history:[2]}}`) or a turn variable name (`{{history:turns}}`). See [Variables and templates](#variables-and-templates).

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

**History** — use `{{history:[N]}}` in the image prompt to include the last N turn-pairs of chat history.

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

### Update

**Stage: postMessage**

Writes data to a lorebook entry or edits the message text. Choose between two targets.

#### Lorebook target

Creates or updates a lorebook entry. The lorebook file must already exist in SillyTavern's World Info panel.

**Lorebook** — the name of the lorebook file to write to.

**Title** — the entry's display name. Used to locate an existing entry. Supports template variables.

**Keys** — comma-separated trigger keywords. Optional. On update, new keys are merged into the existing key list rather than replacing it.

**Content** — the entry body. Supports all template variables.

**Save as** — stores the entry title on success, for use by later actions.

If an entry with the given title already exists, its content is replaced and new keys are merged in. If no entry is found, a new one is created. After saving, the lorebook cache refreshes so `{{lbContent:...}}` tokens and lorebook keyword triggers in the same turn see the updated data immediately.

This target fires early — as soon as the trigger keyword is seen during streaming and the template's variables are available — rather than waiting for the full message. The lorebook write is authoritative but happens at postMessage; the early-fired result is used to resolve downstream variable dependencies without blocking the stream.

**Power pattern:** call LLM (silent, save as `bio`) → update (lorebook target) with `{{bio}}` as content. The AI's response generates character data; the rule writes it to the lorebook in the same turn.

#### Text target

Edits the message text directly. Choose an output mode:

| Mode | Effect |
|---|---|
| Replace keyword | Replaces every occurrence of the matched keyword with the configured value |
| Replace paragraph | Replaces the entire paragraph containing the keyword |
| Append to message | Adds the value at the end of the message |
| Insert as message | Inserts the value as a new AI message after the current one |

**Value** — the text to write. Supports all template variables.

**Save as** — stores the written text, for use by later actions.

**Note on conflicts:** if two update (text) actions in the same rule, or two separate rules, write to the same slot — same mode and keyword, or same lorebook entry title — the later one overwrites the first. A clobbering warning appears in amber at the bottom of the rule card when this is detected. The warning is informational; you can resolve it by combining both into a single action or by using distinct target slots.

---

## Variables and templates

Variables carry data within and between rules during a single turn. Rule variables are scoped to a single rule's action templates, but their values are published to a turn-level store that other rules and trigger keyword fields can read. All turn variables are cleared at the start of each new generation.

### System variables

Available in every template field, in every action:

| Variable | Value |
|---|---|
| `{{keyword}}` | The matched keyword, regex capture, or trigger sentinel |
| `{{up-to}}` | All message text before the first keyword occurrence |
| `{{paragraph}}` | The paragraph containing the keyword |
| `{{message}}` | The full message text |
| `{{history:[2]}}` | Last 2 turn-pairs of chat history — N in brackets is a literal; bare name reads a turn variable (`{{history:turns}}`) |
| `{{char}}` | Character name |
| `{{user}}` | User name |
| `{{highlighted}}` | Text selected in the browser when a badge button was clicked; empty string for all other trigger types |
| `{{lbTitles:...}}` | Comma-separated list of lorebook entry titles — see [Lorebook query tokens](#lorebook-lookup-in-templates) |
| `{{lbKeys:...}}` | Comma-separated list of lorebook trigger keys — same syntax |
| `{{lbContent:...}}` | Body of a lorebook entry — same syntax |
| `{{lbBooks:...}}` | Comma-separated names of lorebooks that contain matching entries — same syntax |
| `{{psName}}` | Names of every slot in the last generation's context stack — see [Prompt-slot tokens](#prompt-slot-tokens) |
| `{{psName:[filter]:[mode]}}` | Names of matching prompt slots |
| `{{psContent}}` | Content of the first slot in the last generation's context stack |
| `{{psContent:[filter]:[mode]}}` | Content of matching prompt slots |

### Rule variables

Set by a compose variable or call LLM action (via the **Save as** field).

**Within a rule:** the variable is available to every action that follows. Set `Save as` to a name like `label` in an earlier action, then reference it as `{{label}}` in any later action's template within the same rule.

**Across rules:** action template fields (`{{label}}`) are scoped to a single rule — they do not see variables from other rules directly. What does carry across is the underlying value: after each action runs, its `Save as` value is written to a turn-level store that persists until the next generation.

Two ways a later rule can consume a turn variable:

- **Variable match trigger** — test the variable's value. When the trigger fires, the value becomes `{{keyword}}` in that rule's action templates.
- **Keyword fields** — the keywords field of a keyword match trigger or inline badge trigger expands `{{varName}}` from the turn store before matching. This lets a variable that contains a comma-separated list of terms act as a dynamic keyword source.

Cross-rule data flow pattern (variable match):
1. Rule A action: `Save as` → `bio`
2. Rule B trigger: variable match on `bio`, operator not empty
3. Rule B fires → `{{keyword}}` = the value of `bio`

Cross-rule data flow pattern (keyword expansion):
1. Rule A action: `Save as` → `targets` with value `dragon, wyvern, basilisk`
2. Rule B keyword match trigger: keywords = `{{targets}}`
3. Rule B fires when the message contains "dragon", "wyvern", or "basilisk"

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

### Template transforms

String transforms run after all `{{varName}}` substitution and math evaluation. They accept a resolved value and return a modified string.

| Transform | Effect |
|---|---|
| `{{trim: val}}` | Strip leading and trailing whitespace and newlines |
| `{{upper: val}}` | Convert to uppercase |
| `{{lower: val}}` | Convert to lowercase |
| `{{lines: N: val}}` | Keep the first N lines (splits on newline) |
| `{{words: N: val}}` | Keep the first N whitespace-separated words |
| `{{default: fallback: val}}` | Return `val` if non-empty after trim, otherwise `fallback` |

`val` is typically a resolved variable reference. Inner `{{varName}}` tokens are substituted before the transform runs:

```
{{trim: {{opts}}}}                         strip blank lines from LLM output before splitting
{{lines: 4: {{opts}}}}                     keep the first 4 lines of opts
{{upper: {{char}}}}                        character name in uppercase
{{default: nothing yet: {{summary}}}}      fall back to "nothing yet" if summary is unset
```

**Transforms and badge splitting.** When using a bottom badge with `split-on: \n` to render one badge per line of LLM output, wrap the label in `{{trim:}}` to prevent empty badges from trailing blank lines the model may have added:

```
label:    {{trim: {{opts}}}}
split-on: \n
```

**`{{default:}}` note.** The fallback text may not contain a colon — the first `:` after `default:` is the separator between the fallback and the value. The value should always be a resolved `{{varName}}` reference; a bare unresolved name is passed through as a literal string.

---

## Lorebook lookup in templates

### LB query tokens

A unified token family for querying lorebook data by filter. Useful in template fields and especially in keyword fields, where they expand to a comma-separated list of matching terms.

```
{{lbTitles:[lbname]:[titlename]:[keyname]:[mode]:[scope]}}
{{lbKeys:[lbname]:[titlename]:[keyname]:[mode]:[scope]}}
{{lbContent:[lbname]:[titlename]:[keyname]:[mode]:[scope]}}
{{lbBooks:[lbname]:[titlename]:[keyname]:[mode]:[scope]}}
```

All five positions are optional. Omit trailing positions or leave one empty (skip with `::`) to use its default.

**Argument 1 — lorebook filter (`[lbname]`):** Which lorebook(s) to search.

| Form | Selects |
|---|---|
| *(omit)* | All active lorebooks |
| `[Creatures]` | Literal name — one or more in a list |
| `[Creatures, Locations]` | Any lorebook whose name is in the list |
| `Crea*` | Variable name — expands from turn store, then glob-matched |
| `*` | All active lorebooks (explicit wildcard) |

**Argument 2 — title filter (`[titlename]`):** Filter entries by display name. Same forms as argument 1.

**Argument 3 — key filter (`[keyname]`):** Filter entries by trigger key. An entry passes if any of its keys match the filter. Same forms.

**Argument 4 — mode:** What to return when multiple entries match.

| Mode | Returns |
|---|---|
| `all` | All matches, comma-separated (default for `lbTitles`, `lbKeys`, `lbBooks`) |
| `first` | Only the first match (default for `lbContent`) |
| `last` | Only the last match |

**Argument 5 — scope:** Which lorebooks to consider.

| Scope | Considers |
|---|---|
| *(omit)* | Active lorebooks only — the four WI sources ST loads each turn: global panel, character-attached, chat-pinned, persona |
| `active` | Same as omitting — explicit form |
| `all` | Every lorebook file on disk; use for lorebooks intentionally kept out of ST's WI slots |
| `inactive` | Only lorebooks on disk that are not in any active slot (complement of `active`) |

#### Examples

```
{{lbTitles}}                                      — all entry titles across active lorebooks
{{lbTitles:[Creatures]}}                          — titles from the Creatures lorebook
{{lbKeys:[Creatures]:[dragon]}}                   — keys of entries titled "dragon" in Creatures
{{lbContent:[Creatures]:[dragon]::first}}         — body of the first entry titled "dragon"
{{lbTitles:::dragon*}}                            — titles of entries with a key starting with "dragon"
{{lbTitles:[MyLB]:::all}}                         — all titles from MyLB (explicit all)
{{lbBooks}}                                       — names of all active lorebooks
{{lbBooks:::[love]}}                              — which lorebooks have an entry with key "love"
{{lbBooks::[Elara]}}                              — which lorebooks have an entry titled "Elara"
{{lbTitles::::all}}                               — titles from every lorebook on disk
{{lbTitles:[Hidden]::::all}}                      — titles from the "Hidden" lorebook even if inactive
{{lbTitles::::inactive}}                          — titles from lorebooks not currently in any WI slot
```

Using a variable as a filter argument:

```
{{lbTitles:[targetLorebook]}}
```

If `targetLorebook` is a turn variable set to `Creatures`, this expands to all entry titles from the Creatures lorebook. If the variable is not set this turn, the argument is treated as an empty wildcard (matches everything).

#### Keyword field preview

When an LB query token or turn variable appears in a keyword field, the preview below the field shows the resolved list at the time of the last evaluation. Unresolved variables appear dimmed as `{{varName}} — not set this turn`.

---

## Prompt-slot tokens

`{{psName}}` and `{{psContent}}` surface the exact context stack that was sent to the main LLM for the most recent generation. This lets action templates reference the same World Info entries, RAG results, or any other named prompt slot that the model actually saw — useful for side-call prompts that should mirror the main call's context.

Data is sourced from SillyTavern's `itemizedPrompts` snapshot, which captures the full `rawPrompt` (the array of messages sent to the API) at generation time. Slot names are resolved through the currently loaded PromptManager preset; system slots (`worldInfoBefore`, `main`, etc.) use their built-in names, CNZ slots use their configured names, and user-created prompt slots use their display names.

**Availability:** prompt-slot tokens only resolve at postMessage stage, after the generation completes. They produce no output during streaming or when fired without a committed message.

### Syntax

```
{{psName:[nameFilter]:[mode]}}
{{psContent:[nameFilter]:[mode]}}
```

Both arguments are optional. Leave either argument empty (or omit it entirely) to use the default.

**`nameFilter`** — which slots to include. Same three forms as lorebook query filters:

| Form | Selects |
|---|---|
| *(omit)* | All slots (wildcard) |
| `[worldInfoBefore]` | Literal identifier or display name |
| `[CNZ RAG]` | Literal display name — resolved via the current preset |
| `[world*]` | Glob pattern on identifier or display name |
| `myVar` | Turn variable — its value is used as the filter |

**`mode`** — what to return when multiple slots match:

| Mode | `{{psName}}` default | `{{psContent}}` default |
|---|---|---|
| `all` | Yes — all names, newline-separated | Joins all contents with a blank line |
| `first` | Only the first match | Yes — only the first match |
| `last` | Only the last match | Only the last match |

The order of slots matches the PromptManager order — the same top-to-bottom sequence visible in the ST prompt editor.

### Examples

```
{{psName}}                           — all slot names from the last generation, one per line
{{psName::first}}                    — name of the first slot
{{psName:[worldInfo*]}}              — names of all worldInfo* slots (e.g. worldInfoBefore, worldInfoAfter)
{{psContent}}                        — content of the first slot (wildcard, first mode)
{{psContent::all}}                   — full context stack, all slots joined with blank lines
{{psContent:[cnz_rag]}}              — content of the CNZ RAG slot by identifier
{{psContent:[CNZ RAG]}}              — same, by display name
{{psContent:[worldInfoBefore]}}      — World Info Before content
{{psContent:[worldInfo*]:all}}       — all worldInfo slot contents joined with blank lines
{{psContent:mySlot}}                 — content of the slot whose name/identifier is stored in myVar 'mySlot'
```

### Use cases

**Mirror main-call RAG in a side call.** If CNZ pulled in RAG content for the main reply, use `{{psContent:[cnz_rag]}}` in a call LLM prompt to give the side model the same retrieved context.

**Audit context stack.** Compose a variable with `{{psName}}` to log which slots were active for a given generation — useful for debugging prompt construction.

**Conditional on slot presence.** Combine with `{{if ... empty}}`: if `{{psContent:[cnz_rag]}}` is empty, a RAG slot was absent and a fallback branch can run instead.

**Full stack replay.** `{{psContent::all}}` produces the entire context in PromptManager order — every slot concatenated with blank-line separators. This is useful for analytics or summarisation side calls that need the full prompt.

---

## When things fire

Triggeryze operates at two distinct stages of the generation lifecycle:

| Stage | When | Actions available |
|---|---|---|
| **generationStart** | When a new AI turn begins, before any tokens | postMessage actions (compose variable, slash commands) |
| **stream** | As each token arrives, before the message is committed | stop, slash commands |
| **postMessage** | After the full message is saved | replace, call LLM, compose variable, generate image, slash commands, update |
| **manual** | When a badge button or inline badge span is clicked | all postMessage actions |

The **event trigger** determines which stage a rule enters. An event trigger set to **generation started** fires a postMessage-stage rule pass before the stream begins. An event trigger set to **chat complete** fires the standard postMessage pass. The badge trigger fires only on click (manual stage).

A rule can have actions at both stages. They fire at different moments in the same generation. A common pattern: a stop rule halts the stream on a sentinel keyword; a replace rule on the same keyword removes it from the saved message.

**Early firing.** Some postMessage actions can fire during streaming as soon as their template dependencies are available, rather than waiting for the full message. This eliminates latency when a template does not reference `{{message}}` or `{{paragraph}}`:

| Action | Fires early when |
|---|---|
| Compose variable | No `{{message}}` or `{{paragraph}}` in the template |
| Generate image | No `{{message}}` or `{{paragraph}}` in the prompt |
| Update (lorebook target) | No `{{message}}` or `{{paragraph}}` in any template field |

Actions fired early are marked so they are not repeated at postMessage. Update (text target) shows a live preview during streaming but the authoritative message write still occurs at postMessage stage.

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

If any rule uses a **badge (top style)** trigger, additional labeled buttons appear next to the status pill — one per enabled rule.

If any rule uses a **badge (bottom style)** trigger, additional labeled buttons appear below the message text. Multiple badges from a single rule (via the split field) are stacked vertically.

Clicking any badge button fires that rule, injects the badge label to the input box, or injects and sends — depending on the click action configured on the badge trigger.

### Inline badge spans

If any rule uses a **badge (inline style)** trigger, matching words inside the message text itself are wrapped in clickable colored spans. These appear inside the message body, not next to the status pill.

Inline badge spans are scoped to the current turn. They are injected when the response finishes (and progressively during streaming), and stripped at the start of the next generation. Historical messages do not carry inline badges.

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

**Event trigger (chat complete) and stream-stage actions**
The event trigger's chat complete event only fires after the message is committed. Pairing it with a stop action (with or without "and continue") has no effect — stop requires an active stream, which no longer exists at that point.

**Variable match with no upstream rule**
If a variable match trigger names a variable that was never set this turn, the trigger does not fire and a warning is written to the browser console. Check that the upstream rule is enabled, fires before the variable match rule in the list, and has its Save as field filled in with the matching name.

Exception: the **is not set** operator intentionally fires when the variable is absent. No upstream rule is required — the trigger succeeds precisely because the variable does not exist.

**Badge trigger and AND logic**
A badge trigger (any style) combined with other triggers using AND prevents the rule from auto-firing. The badge trigger's test always returns false during automatic rule scanning — it only activates on click. Use OR logic if you want a rule that fires both automatically on a keyword match and manually on badge click.

**Slash commands fires at stream and postMessage stages by default**
A slash commands action evaluates twice per turn: once during streaming and once after the message is committed. If your command assumes the message is fully written — reading `{{message}}`, using `/send`, or similar — pair the rule with a chat complete trigger using all logic. This constrains the rule to postMessage stage only, preventing the action from running against a partial message.

**Update (lorebook target) requires an existing lorebook file**
The update action can create and update entries within a lorebook, but it cannot create the lorebook file itself. Create the lorebook in SillyTavern's World Info panel before referencing it in this action.

**Inline badges are stripped at the start of each generation**
Inline badge spans only exist on the current turn's message. When a new generation begins, all spans are removed from every message in the chat. This is intentional — badges are resolved against turn variables and lorebook state that change each turn, so keeping them on older messages would mean showing stale data. If you need a badge to persist on an older message, consider using a badge button trigger instead.

**Clobbering warning on the rule card**
An amber warning appears at the bottom of a rule card when two postMessage actions in that rule — or across two rules in the same list — write to the same target slot (same text replacement mode and keyword, or same lorebook entry title). The warning is informational. The later action wins. Resolve it by combining both writes into a single action or by choosing distinct target slots.

**Circular variable dependencies within a rule cause a hang**
If action A reads `{{y}}` (produced by action B) and action B reads `{{x}}` (produced by action A), neither action can start — each is waiting on the other's output. The rule hangs silently with no error or timeout. Within-rule dependency chains must be linear: A → B → C, never looping back.

Cross-rule cycles are safe. Each rule fires at most once per turn, so a loop of Rule A → Rule B → Rule A terminates after Rule A fires in the first pass — it is deduped out of all subsequent passes.
