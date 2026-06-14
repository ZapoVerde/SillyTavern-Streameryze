# Triggeryze — User Guide

## Rules

A rule pairs one or more triggers with one or more actions. When the AI generates a response, Triggeryze evaluates every enabled rule. If the trigger conditions are met, the actions run.

Rules are evaluated in list order. Each rule fires at most once per stage per turn.

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

**Source** — which image backend to use. Supported backends include Pollinations, FAL AI, Black Forest Labs, Stability AI, OpenAI, Google, Together AI, Chutes AI, Electron Hub, NanoGPT, xAI, Z AI, AIML API, OpenRouter, ComfyUI, and all of SillyTavern's local backends (A1111, VLAD, SD.cpp, Draw Things, NovelAI, Extras, Horde).

**Model** — the model to use. Auto-populated from the selected source's model list.

**History** — include N prior chat turns as `{{history}}` in the image prompt.

**Save as** — stores the uploaded image path in a named variable for use by later actions.

**Prompt template** — the image prompt. Supports all template variables.

**Persist in chat** — when enabled, the image is saved to the chat and reloads with it. When disabled, the image appears for this session only.

Image generation runs in the background and does not block the next message. If the user swipes before the image arrives, the result is discarded.

The **Test** button previews the image without attaching it to any message.

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
| `{{getLBcontent [Entry Name]}}` | Lorebook entry by literal title |

### Rule variables

Set by a compose variable or call LLM action (via the **Save as** field). Available to every action that follows in the same rule. They are also published turn-wide: a variable match trigger in a later rule can test the value set here.

To use one within a rule: set `Save as` to a name like `label` in the earlier action, then reference it as `{{label}}` in a later action's template.

To use one across rules: add a variable match trigger to the later rule and enter the same name. Triggeryze's stability loop re-evaluates rules after each firing, so rule A sets the variable in pass one and rule B's trigger sees it in pass two.

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
| `[Elara Voss]` | Literal entry name — brackets required for names with spaces |
| `Elara Voss` | Literal entry name, no brackets needed if single word |
| `MyLorebook:[Elara Voss]` | Same, scoped to a specific lorebook |

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
| **stream** | As each token arrives, before the message is committed | stop, stop + continue |
| **postMessage** | After the full message is saved | replace, call LLM, compose variable, generate image |
| **manual** | When a badge button is clicked | all postMessage actions |

A rule can have actions at both stages. They fire at different moments in the same generation. A common pattern: a stop rule halts the stream on a sentinel keyword; a replace rule on the same keyword removes it from the saved message.

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
