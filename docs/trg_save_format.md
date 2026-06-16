# Triggeryze — Save Format v2

*Specification for the import/export JSON format. Covers motivation, approach, and complete schema.*

---

## Why

Triggeryze's primary growth path is LLM-generated rulesets: a user describes what they want, an LLM writes JSON, the user imports it. The current format blocks this in three ways.

**Type keys are internal code names.** `sideCall`, `slashCmd`, `setStVar`, `keywordMatch` — none of these appear in the UI. An LLM told to write a "call LLM action" writes `type: "callLLM"` and the import silently succeeds with an action that never fires.

**The `config` wrapper is pure noise.** Every trigger and action wraps its fields in a `config: {}` object with no semantic value. It adds a nesting level that makes the format harder to read and write.

**Import failures are silent.** A missing `id` drops the rule entirely. An unknown type key imports the rule but the action is a no-op. Neither produces a visible error. For LLM-generated content, silent failure means the user has no path to diagnosis.

---

## How

Changes are made **at the import/export boundary only.** Internal registry keys (`sideCall`, `slashCmd`, etc.) and the engine are unchanged. A translation layer maps format keys to registry keys on import and back on export.

### Human-readable type keys

All type keys use kebab-case matching what the user sees in the UI. `sideCall` → `call-llm`, `slashCmd` → `slash-cmd`, `keywordMatch` → `keyword`, etc. Full mapping in the [Action types](#action-types) and [Trigger types](#trigger-types) sections.

### Flat config

Fields live directly on the trigger or action object. No `config: {}` wrapper.

```json
// before
{ "type": "keywordMatch", "config": { "keywords": "dragon", "caseSensitive": false } }

// after
{ "type": "keyword", "keywords": "dragon" }
```

### JSONC comment support

`//` line comments and `/* */` block comments are stripped before parse. An LLM can annotate a ruleset freely. Comments do not survive the round-trip — use `note` fields for annotations that should persist.

### `note` field

Any rule, trigger, or action accepts an optional `note` string. The engine ignores it. It is preserved through import and export. LLMs use it to record intent; humans use it to verify the LLM's reasoning without reading config fields.

### Named import validation

Unknown types, unknown enum values, and missing required fields produce named warnings: the rule name, position, and a specific description of the problem. Rules still import — broken triggers and actions are skipped, not the whole rule.

### Auto-generated `id`

A missing `id` no longer drops the rule. One is generated on import.

---

## What

### File shapes

The importer accepts three shapes, detected by structure — no `type` field required.

**Profile** — has a `rulesets` array:

```jsonc
{
  "name": "My Profile",     // optional
  "rulesets": [ /* ruleset objects */ ]
}
```

**Ruleset** — has a `rules` array (no `rulesets`). Imported as a new group appended to the active profile.

```jsonc
{
  "name": "Sentinel handling",   // optional
  "rules": [ /* rule objects */ ]
}
```

**Single rule** — has `triggers` and `actions` arrays. Imported into the active profile's last ruleset, or a new "Imported" ruleset if none exists.

```jsonc
{
  "name": "My Rule",   // optional
  "triggers": [ ... ],
  "actions": [ ... ]
}
```

A bare array of rule objects is treated as a nameless ruleset.

---

### Ruleset object

Rulesets are purely organizational. They group related rules under a name and allow enabling or disabling the whole group at once. They have no effect on evaluation order or correctness — the engine's fixed-point loop at postMessage stage means rules across all rulesets resolve variable dependencies regardless of group order. Rulesets can be freely arranged without affecting how rules interact.

A disabled ruleset removes all its rules from engine consideration for the turn, identical to having each rule individually disabled.

```
name      string    display name; defaults to "Group N"
note      string    intent annotation; engine ignores it; preserved in export
enabled   boolean   defaults to true; when false, all rules in the group are skipped
rules     rule[]    required
```

Example:

```jsonc
{
  "name": "Sentinel handling",
  "note": "Stop the stream on [DONE] and remove it from the committed message. Two rules because stop fires at stream stage and replace fires at postMessage.",
  "enabled": true,
  "rules": [
    {
      "name": "Stop on [DONE]",
      "triggers": [ { "type": "keyword", "keywords": "[DONE]" } ],
      "actions": [ { "type": "stop" } ]
    },
    {
      "name": "Strip [DONE]",
      "triggers": [ { "type": "keyword", "keywords": "[DONE]" } ],
      "actions": [ { "type": "replace", "replacement": "" } ]
    }
  ]
}
```

---

### Rule object

```
name       string            display name; defaults to "Rule N"
note       string            intent annotation; engine ignores it; preserved in export
enabled    boolean           defaults to true; omit for default
when       "any" | "all"    how triggers combine; defaults to "any"
triggers   trigger[]         required
actions    action[]          required
```

Example:

```jsonc
{
  "name": "Stop and strip sentinel",
  "note": "Halts the stream on [DONE] then removes it from the committed message. Two rules needed because stop fires at stream stage and replace fires at postMessage.",
  "when": "any",
  "triggers": [
    { "type": "keyword", "keywords": "[DONE]" }
  ],
  "actions": [
    { "type": "stop" }
  ]
}
```

---

### Trigger types

All triggers accept an optional `note` field.

#### `keyword`

Matches one or more words anywhere in the response. The matched text becomes `{{keyword}}`.

```
keywords         string    required; comma-separated; supports * and ? wildcards; supports {{varName}} and lb query tokens
case-sensitive   boolean   default false
```

#### `regex`

Matches a regular expression. The full match (or first capture group) becomes `{{keyword}}`.

```
pattern   string   required; /pattern/flags syntax, or plain string for basic match
```

#### `lb-keyword`

No fields. Fires when the response contains any primary trigger key from the active lorebooks. The matched key becomes `{{keyword}}`.

#### `chat-complete`

No fields. Fires once after the full message is committed. Pair with postMessage actions. `{{keyword}}` is set to `"chat complete"`.

#### `var-match`

Fires when a named turn variable matches a condition. The variable must have been set by an earlier rule this turn. The variable's value becomes `{{keyword}}`.

```
var        string                                                                               required; variable name to test
operator   "equals" | "not-equals" | "contains" | "matches" | "not-empty" | "set" | "not-set"   default "equals"
value      string                                                                               comparison value; omit for "not-empty", "set", "not-set"
```

#### `condition`

Fires when a boolean expression over ST variables evaluates to true.

```
expression   string   required; e.g. "chatvar::stats.hp < 20 AND chatvar::gold >= 100"
```

Operators: `< > <= >= = != matches contains is empty in (…)`
Combinators: `AND OR !` and `( )`
Variable prefixes: `chatvar::` (chat-scoped), `globalvar::` (global), bare name (turn variable)

#### `badge`

Renders a clickable button on AI messages. Never auto-fires — only fires when clicked. `{{keyword}}` is set to the label text. `{{highlighted}}` is set to any browser-selected text at click time.

```
style          "top" | "bottom" | "inline"          default "top"; top = near message header, bottom = after text, inline = wraps matched keywords
label          string                                button label; supports {{varName}}; default "run"
color          string                                hex color; default "#8888ff"
split-on       string                                delimiter to split label into multiple buttons (e.g. "\n" or ",")
keywords       string                                inline style only: comma-separated keywords to wrap as clickable spans
case-sensitive boolean                               inline style only; default false
click          "fire" | "inject" | "inject-send"    what clicking does; default "fire" (runs rule actions)
```

#### `probability`

Fires with the given probability each generation. Combine with `when: "all"` to make any rule probabilistic.

```
chance   number   0–100; default 50
```

#### `event`

Fires on a named lifecycle event. `{{keyword}}` is set to the event name.

```
event   "MESSAGE_RECEIVED" | "GENERATION_STARTED" | "CHARACTER_MESSAGE_RENDERED"   default "MESSAGE_RECEIVED"
```

- `MESSAGE_RECEIVED` — fires once after each AI message is fully received
- `GENERATION_STARTED` — fires when a new AI turn begins, before any tokens arrive; use to clear variables or prepare state
- `CHARACTER_MESSAGE_RENDERED` — fires each time a message is rendered to the DOM, including on chat reload for historical messages

---

### Action types

All actions accept an optional `note` field.

#### `stop`

**Stage: stream.** Halts generation immediately. The partial message is left as-is, keyword included. To also remove the keyword, add a separate rule with a `replace` action.

No fields.

#### `stop-continue`

**Stage: stream.** Halts and immediately resumes generation. Newly triggered lorebook entries will be active in the continued reply.

No fields.

#### `replace`

**Stage: postMessage.** Replaces every occurrence of the matched keyword in the committed message.

```
replacement   string   replacement text; blank to delete the keyword; supports {{vars}}
```

#### `call-llm`

**Stage: postMessage.** Fires an LLM request and routes the result into the message.

```
prompt        string                                                                        required; the LLM prompt; supports {{vars}}
output        "replace-keyword" | "replace-paragraph" | "append" | "insert" | "silent"   default "replace-keyword"
calls         "once" | "per-match"                                                         default "once"
history       number                                                                        prior chat turns to include as {{history}}; default 0
var           string                                                                        save result to this turn variable; available to later actions
connection    string | null                                                                 Connection Manager profile ID; null = main ST LLM (default)
```

Output modes:
- `replace-keyword` — replaces every occurrence of the matched keyword with the result
- `replace-paragraph` — replaces the entire paragraph containing the keyword
- `append` — adds the result at the end of the message
- `insert` — inserts the result as a new AI message after the current one
- `silent` — runs the call but applies no output; use with `var` to capture the result

#### `compose`

**Stage: postMessage.** Evaluates a template and writes the result to a named turn variable. No LLM call.

```
var        string   required; name of the turn variable to write
template   string   required; supports {{vars}} and {{if condition}}…{{/if}} blocks
```

#### `slash-cmd`

**Stage: stream and postMessage.** Executes an ST slash command string. Pair with a `chat-complete` trigger using `when: "all"` to restrict to postMessage only.

```
command   string   required; ST slash command; supports {{vars}}
var       string   save the pipe result of the last command to this turn variable
```

#### `update`

**Stage: postMessage.** Writes to a lorebook entry or edits the message text. The `target` field selects which.

**Lorebook target** (`target: "lorebook"`, the default):

```
target     "lorebook"   required; write this explicitly to avoid ambiguity
lorebook   string       required; lorebook name; must exist in ST's World Info panel; supports {{vars}}
title      string       required; entry title; used to locate an existing entry; supports {{vars}}
keys       string       comma-separated trigger keys; merged into existing keys on update; supports {{vars}}
content    string       entry body; supports {{vars}}
var        string       save the entry title to this turn variable on success
```

If the entry title exists, its content is replaced and new keys are merged in. If no entry is found, a new one is created. The lorebook file must already exist.

**Text target** (`target: "text"`):

```
target   "text"                                                               required
mode     "replace-keyword" | "replace-paragraph" | "append" | "insert"   default "replace-keyword"
value    string                                                            required; supports {{vars}}
var      string                                                            save the written text to this turn variable
```

#### `image`

**Stage: postMessage.** Generates an image and attaches it to the message. Returns immediately — image generation runs in the background.

```
source      string    default "pollinations"; image backend; see valid values below
model       string    model name for the selected source; blank for source default
prompt      string    required; image prompt; supports {{vars}}
history     number    prior chat turns to include as {{history}} in the prompt; default 0
var         string    save the uploaded image path to this turn variable
persist     boolean   save the image to the chat file; default true; false = shown this session only
comfy-url   string    ComfyUI endpoint URL; only used when source is "comfy"
```

Valid `source` values: `pollinations`, `fal`, `bfl`, `stability`, `openai`, `google`, `together`, `chutes`, `electron-hub`, `nanogpt`, `xai`, `zai`, `aiml`, `openrouter`, `huggingface`, `comfy`

#### `set-var`

**Stage: postMessage.** Writes a value to an ST chat variable or global variable. These persist across turns (unlike turn variables, which clear each generation).

```
scope   "chat" | "global"   default "chat"; chat = scoped to this conversation, global = shared across all chats
var     string               required; variable name
key     string               optional; object key or array index — always a string, even for numeric indices (e.g. "0", not 0)
value   string               required; supports {{vars}}
```

---

### Template variables

Available in every string field that supports `{{vars}}`:

```
{{keyword}}                    the matched keyword, regex capture, or trigger sentinel
{{up-to}}                      all message text before the first keyword occurrence
{{paragraph}}                  the paragraph containing the keyword
{{message}}                    the full message text
{{history}}                    recent chat history (N turns, configured per action)
{{char}}                       character name
{{user}}                       user name
{{highlighted}}                browser-selected text at badge click time; empty string for other triggers
{{varName}}                    value of a turn variable named varName
{{getLBcontent keyword}}       lorebook entry body matching the trigger keyword
{{getLBcontent [Entry Name]}}  lorebook entry body by literal title
{{lbTitles:[lb]:[title]:[key]:[mode]:[scope]}}   comma-separated entry titles from lorebook query
{{lbKeys:[lb]:[title]:[key]:[mode]:[scope]}}     comma-separated trigger keys from lorebook query
{{lbContent:[lb]:[title]:[key]:[mode]:[scope]}}  entry body from lorebook query
{{lbBooks:[lb]:[title]:[key]:[mode]:[scope]}}    lorebook names from lorebook query
{{psName:[nameFilter]:[mode]}}      slot names from the last generation's context stack (current preset)
{{psContent:[nameFilter]:[mode]}}   slot content from the last generation's context stack (current preset)
```

`lb` query arguments: all slots are optional (empty = wildcard). `mode`: `first | last | all` (default: `all` for titles/keys/books, `first` for content). `scope`:

```
active    (default, omit) — entries from the four active WI sources: global panel, character, chat, persona
all       — every lorebook on disk; use for lorebooks intentionally kept out of ST's WI slots
inactive  — only lorebooks on disk that are NOT in any active slot (complement of active)
```

`ps` token arguments: `nameFilter` is optional (empty = all slots). Filter forms: `[identifier]` literal identifier, `[Display Name]` literal display name (resolved via the current PromptManager preset), `glob*` pattern, or bare `varName` (turn variable). `mode`: `first | last | all` (default: `all` for `psName`, `first` for `psContent`). Resolves postMessage only — no output during streaming.

```
{{chatvar::varName}}           ST chat variable
{{globalvar::varName}}         ST global variable
{{math: expr}}                 evaluate a numeric expression after all variable substitution (e.g. {{math: {{hp}} + 10}})
```

Conditional blocks (non-nestable):

```
{{if condition}}text{{/if}}
```

Condition operators: `matches "regex"`, `contains "text"`, `is "value"`, `in (a, b, c)`, `empty`
Combinators: `AND`, `OR`, `!`, `( )`

---

### Import behavior

1. Strip `//` line comments and `/* */` block comments before parse
2. Detect file shape by structure:
   - Has `rulesets` array → profile
   - Has `rules` array (no `rulesets`) → ruleset; appended to the active profile as a new group
   - Has `triggers` and `actions` → single rule; appended to the active profile's last ruleset
   - Bare array → treated as a nameless ruleset
3. For each ruleset: auto-generate `id` if absent; default `enabled` to `true`
4. For each rule: auto-generate `id` if absent; default `enabled` to `true`; default `when` to `"any"`
5. For each trigger and action: map the format type key to the internal registry key
6. Collect warnings for:
   - Unknown `type` value — name the type and list valid values
   - Unknown enum value — name the field, the bad value, and the valid values; fall back to the default
   - Missing required field — name the field; skip only the affected trigger or action, not the whole rule
7. If any warnings were collected: show a summary toast ("N warnings — see console") and write full detail to the console
8. Broken triggers and actions are skipped; their parent rule still imports; broken rules still import into their ruleset

### Export behavior

1. Write the v2 format (flat config, kebab type keys, `when` field, `rulesets` array)
2. Preserve `note` fields on all objects
3. Include `id` on rulesets and rules (prevents duplicate creation on re-import)
4. Omit `enabled` when true (default); write `"enabled": false` explicitly
5. Omit optional fields that are empty, null, or equal to their default value
6. Ruleset export produces a file with a top-level `rules` array — detected as a ruleset on re-import

---

## Examples

Complete importable rulesets. Each block is valid JSONC — save as `.json` and import via the Import button in the profile bar.

---

### Sentinel stop and strip

The canonical two-rule stop pattern. `stop` fires at **stream** stage; `replace` fires at **postMessage**. They cannot be collapsed into one rule — a single rule is bound to one stage.

```jsonc
{
  "name": "Sentinel handling",
  "note": "Stop the stream on [DONE] and remove it from the committed message. Two rules because stop and replace operate at different pipeline stages.",
  "rules": [
    {
      "name": "Stop on [DONE]",
      "triggers": [ { "type": "keyword", "keywords": "[DONE]" } ],
      "actions": [ { "type": "stop" } ]
    },
    {
      "name": "Strip [DONE]",
      "note": "replace fires postMessage, after the full message is saved.",
      "triggers": [ { "type": "keyword", "keywords": "[DONE]" } ],
      "actions": [ { "type": "replace", "replacement": "" } ]
    }
  ]
}
```

---

### Anti-slop paragraph rewrite

One rule, two sequential actions. The `compose` action writes a banned-phrase list to the `banned` turn variable; the `call-llm` action reads it via `{{banned}}`. Actions within a rule share a variable store and execute in listed order, so a later action can always read what an earlier one wrote.

```jsonc
{
  "name": "Anti-slop",
  "rules": [
    {
      "name": "Rewrite cliché",
      "triggers": [
        {
          "type": "regex",
          "pattern": "/\\b(breath\\s+catch\\w*|catch\\w*\\s+breath|anchoring|tether|ledger|claiming|stone\\s+dropped\\s+into\\s+water)\\b/i"
        }
      ],
      "actions": [
        {
          "type": "compose",
          "var": "banned",
          "note": "Store the full list once so {{banned}} is available in the LLM prompt below.",
          "template": "breath catch / catch breath\nanchoring\ntether\nledger\nclaiming\nstone dropped into water"
        },
        {
          "type": "call-llm",
          "output": "replace-paragraph",
          "prompt": "The paragraph contains the prohibited phrase \"{{keyword}}\".\n\nFull banned list:\n{{banned}}\n\nRewrite this paragraph to remove the phrase entirely. Change the physical action or internal reaction — do not substitute a synonym or near-synonym. Output only the rewritten paragraph, nothing else.\n\n{{paragraph}}"
        }
      ]
    }
  ]
}
```

---

### Dynamic continuation badges

A two-rule cross-stage flow. Rule 1 fires after each AI message, calls the LLM silently, and stores three short continuation options in `opts`. Rule 2 renders `opts` as clickable bottom badges — one per line — that inject and send the selected option.

The badge rule carries no actions. `click: "inject-send"` on the trigger handles the interaction directly; the actions list is never reached.

The `split-on` value `"\\n"` is the literal two-character string `\n` as entered in the UI. The badge renderer interprets it as a newline and splits the resolved label on it.

```jsonc
{
  "name": "Continuation badges",
  "note": "After each message, generate three short continuation options and render them as clickable send buttons below the response.",
  "rules": [
    {
      "name": "Generate options",
      "note": "MESSAGE_RECEIVED fires postMessage. output:silent runs the LLM but writes nothing to the message — the result goes to opts instead.",
      "triggers": [
        { "type": "event", "event": "MESSAGE_RECEIVED" }
      ],
      "actions": [
        {
          "type": "call-llm",
          "output": "silent",
          "var": "opts",
          "history": 4,
          "prompt": "Generate exactly three short continuation prompts from {{user}}'s perspective in an ongoing roleplay with {{char}}. Each must be under 12 words. Output only the three options, one per line, no numbering, no extra text.\n\n{{history}}"
        }
      ]
    },
    {
      "name": "Show option badges",
      "note": "split-on splits opts on newlines, producing one badge per option. click:inject-send submits the option when clicked.",
      "triggers": [
        {
          "type": "badge",
          "style": "bottom",
          "label": "{{opts}}",
          "split-on": "\\n",
          "click": "inject-send"
        }
      ],
      "actions": []
    }
  ]
}
```
