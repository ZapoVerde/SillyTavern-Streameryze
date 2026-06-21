# Triggeryze — Ruleset Syntax

Import/export JSON format reference. JSONC (`//` and `/* */` comments) are stripped before parse and do not survive the round-trip — use `note` fields for annotations that persist. Any rule, trigger, or action accepts an optional `note` string; the engine ignores it.

---

## File shapes

Detected by structure. No `type` field required.

- **Profile** — top-level `rulesets` array
- **Ruleset** — top-level `rules` array; appended to the active profile as a new group
- **Single rule** — has `triggers` and `actions`; appended to the active profile's last ruleset
- **Bare array** — treated as a nameless ruleset

---

## Ruleset

```
name      string    display name; defaults to "Group N"
note      string    preserved in export; engine ignores
enabled   boolean   default true; false skips all rules in the group
rules     rule[]    required
```

---

## Rule

```
name       string           display name; defaults to "Rule N"
note       string           preserved in export; engine ignores
enabled    boolean          default true
when       "any" | "all"   how triggers combine; default "any"
triggers   trigger[]        required
actions    action[]         required
```

---

## Execution model

**Rules fire as early as possible.** The engine evaluates rules on every stream token. What determines when a rule's actions actually execute is which tokens the template uses:

| Template uses | Action fires |
|---|---|
| `{{up-to}}`, `{{keyword}}`, turn variables, lorebook tokens | Immediately on trigger match — during streaming |
| `{{paragraph}}` | When the current paragraph boundary closes |
| `{{message}}` | After the full message is committed |

`{{up-to}}` is everything the AI has written up to the trigger match. A `call-llm` prompt that only uses `{{up-to}}` launches the moment the keyword appears — in most cases the result is ready before streaming ends.

`stop` always runs during the stream. `replace` applies visually on every stream token and writes authoritatively at postMessage — it always does both. `slash-cmd` runs at both by default. All other actions fire as early as their template dependencies allow.

**Deduplication.** Each rule fires at most once per turn. `stop` and postMessage actions track dedup separately — this is what makes the stop-and-strip pattern work: two rules matching the same keyword, one halting the stream and one removing the keyword from the committed message.

**Turn variables.** Set by `compose` (`var` field) and `call-llm` (`var` field). Variables are **ruleset-scoped** by default — a variable written by a rule in one group is only visible to other rules in the same group. Prefix the name with `$` (e.g. `$emotion`) to make it global: global variables are readable and writable by rules in any group. Cleared at the start of each new generation. Distinct from `chatvar::` / `globalvar::` ST variables, which persist across turns.

**Cross-rule ordering.** At postMessage stage, rule order in the list does not affect correctness. A `var-match` rule listed before its upstream producer resolves on the next loop pass. Write rules around what they detect, not where they sit in the list. `stop` and `slash-cmd` evaluate in list order during the stream.

---

## State persistence

Four stores are available. Choose by lifetime and content size:

| Store | Lifetime | Best for |
|---|---|---|
| Turn variable | Current turn only | Intermediate results; routing within a group; prefix with `$` to share across groups |
| `chatvar::` | Persistent, per-chat | Numeric state, flags, and strings scoped to one character or chat — HP, gold, mood |
| `globalvar::` | Persistent, global | Settings and flags that apply across all chats — style preferences, feature toggles |
| Lorebook entry | Persistent | Long-form text that needs keyword-driven context injection or `{{lbContent:…}}` lookup |

Turn variables are set with `compose` or `call-llm` (`var` field) and read via `{{varName}}`. ST variables are written with `set-var` and read via `{{chatvar::name}}` or `{{globalvar::name}}` in templates, or tested directly in `condition` expressions. Lorebook entries are written with `update` and read via `{{lbContent:…}}` or auto-injected by ST when their keys match recent message text.

### Turn variable — pass extracted data between rules

Parse a value from the AI message and route it to a `var-match` rule. Turn variables vanish at the end of the turn — nothing to clean up.

```jsonc
{
  "name": "Mood routing",
  "rules": [
    {
      "name": "Parse mood",
      "triggers": [ { "type": "event", "event": "MESSAGE_RECEIVED" } ],
      "actions": [
        {
          "type": "call-llm",
          "output": "silent",
          "var": "mood",
          "prompt": "Read the message and output one word for {{char}}'s emotional state: happy, sad, angry, fearful, or neutral. Output the word only.\n\n{{message}}"
        }
      ]
    },
    {
      "name": "React to anger",
      "triggers": [ { "type": "var-match", "var": "mood", "operator": "equals", "value": "angry" } ],
      "actions": [
        { "type": "slash-cmd", "command": "/echo {{char}} seems angry this turn" }
      ]
    }
  ]
}
```

### chatvar — per-character state across turns

Write a numeric value with `set-var` (`scope: "chat"`). Read it in templates via `{{chatvar::name}}` or test it with a `condition` trigger. The value survives across turns and is saved with the chat file. The `{{default:…}}` transform guards against an uninitialized variable on first use.

```jsonc
{
  "name": "HP tracker",
  "rules": [
    {
      "name": "Apply damage",
      "triggers": [ { "type": "keyword", "use-regex": true, "pattern": "/takes? (\\d+) damage/i" } ],
      "actions": [
        {
          "type": "compose",
          "var": "new_hp",
          "template": "{{math: {{default: 100: {{chatvar::hp}}}} - {{keyword}}}}"
        },
        {
          "type": "set-var",
          "scope": "chat",
          "var": "hp",
          "value": "{{new_hp}}"
        }
      ]
    },
    {
      "name": "Low HP warning",
      "note": "Fires in the same postMessage pass once chatvar::hp is updated by the rule above.",
      "triggers": [ { "type": "condition", "expression": "chatvar::hp < 20" } ],
      "actions": [
        { "type": "slash-cmd", "command": "/echo HP critical: {{chatvar::hp}}" }
      ]
    }
  ]
}
```

### globalvar — cross-chat settings and flags

A badge writes a flag to global scope; a `condition` trigger gates another rule on it. `when: "all"` requires both the event and the condition to be true before the narration fires.

```jsonc
{
  "name": "Narrator mode",
  "rules": [
    {
      "name": "Toggle on",
      "triggers": [
        { "type": "badge", "style": "top", "label": "Narrator on", "click": "fire" }
      ],
      "actions": [
        { "type": "set-var", "scope": "global", "var": "narratorMode", "value": "on" }
      ]
    },
    {
      "name": "Narrate when active",
      "when": "all",
      "triggers": [
        { "type": "event", "event": "MESSAGE_RECEIVED" },
        { "type": "condition", "expression": "globalvar::narratorMode = \"on\"" }
      ],
      "actions": [
        {
          "type": "call-llm",
          "output": "append",
          "prompt": "Add a one-sentence third-person narrator observation at the end of this message. Output only that sentence.\n\n{{message}}"
        }
      ]
    }
  ]
}
```

### Lorebook entry — rich text with keyword injection

`call-llm` generates a session summary; `update` writes it into a named lorebook entry. The entry's keys cause ST to auto-inject the content into the next generation's context when those keywords appear in recent messages. Use lorebook entries when the stored text is long, needs a name for lookup, or should flow into context automatically.

```jsonc
{
  "name": "Session memory",
  "rules": [
    {
      "name": "Summarize and store",
      "triggers": [ { "type": "event", "event": "MESSAGE_RECEIVED" } ],
      "actions": [
        {
          "type": "call-llm",
          "output": "silent",
          "var": "summary",
          "prompt": "Summarize the key events from the last few exchanges in 2-3 sentences. Focus on what changed: decisions made, things revealed, actions taken.\n\n{{history:3}}"
        },
        {
          "type": "update",
          "target": "lorebook",
          "lorebook": "MyWorld.json",
          "title": "Session memory — {{char}}",
          "keys": "{{char}}, memory, recent events",
          "content": "{{summary}}"
        }
      ]
    }
  ]
}
```

---

## Trigger types

All triggers accept an optional `note` field.

### `keyword`

Matched text → `{{keyword}}`. Two sub-modes controlled by the optional `mode` field.

```
mode   "text" | "lorebook"   default "text"; omitted in export
```

**mode: `text`** (default)

```
keywords         string    required when use-regex is false; comma-separated; * and ? wildcards; supports {{varName}} and lb query tokens
case-sensitive   boolean   default false; ignored when use-regex is true
use-regex        boolean   default false; when true, match against pattern instead of keywords
pattern          string    required when use-regex is true; /pattern/flags syntax or plain string; full match or first capture group → {{keyword}}
```

**mode: `lorebook`**

No extra fields. Fires on any primary key from the active lorebooks (globally selected, character-attached, chat-pinned, and persona).

### `event`

```
event   "MESSAGE_RECEIVED" | "GENERATION_STARTED" | "CHARACTER_MESSAGE_RENDERED"   default "MESSAGE_RECEIVED"
```

- `MESSAGE_RECEIVED` — once after each AI message is fully committed
- `GENERATION_STARTED` — at turn start before any tokens; use to reset variables
- `CHARACTER_MESSAGE_RENDERED` — on every DOM render, including chat reload

### `var-match`

Fires when a named turn variable matches a condition. The variable must have been set by a `compose` or `call-llm` (`var` field) action in an earlier-firing rule this turn. Variable value → `{{keyword}}`.

```
var        string                                                                      required
operator   "equals" | "not-equals" | "contains" | "not-empty" | "set" | "not-set"   default "equals"
value      string                                                                      omit for "not-empty", "set", "not-set"
use-regex  boolean                                                                     default false; when true, value is a regex pattern; omit for "not-empty", "set", "not-set"
```

### `condition`

Fires when a boolean expression over ST variables evaluates to true.

```
expression   string   required; e.g. "chatvar::stats.hp < 20 AND chatvar::gold >= 100"
```

Operators: `< > <= >= = != matches contains is empty in (…)`
Combinators: `AND OR !` and `( )`
Prefixes: `chatvar::` (chat-scoped), `globalvar::` (global), bare name (turn variable)

### `badge`

Renders a clickable button on AI messages. Never auto-fires. Label text → `{{keyword}}`. Browser-selected text at click time → `{{highlighted}}`.

```
style          "top" | "bottom" | "inline"          default "top"
label          string                                button label; supports {{varName}}; default "run"
color          string                                hex color; default "#8888ff"
graph          boolean                               top/bottom only: render badge in monospace font; default false
split-on       string                                delimiter to split label into multiple buttons; use \\n for newline, , for comma
keywords       string                                inline only: comma-separated keywords to wrap as clickable spans; omit when use-regex is true
case-sensitive boolean                               inline only; default false; omit when use-regex is true
use-regex      boolean                               inline only; default false; when true, use pattern instead of keywords
pattern        string                                inline only; required when use-regex is true; /pattern/flags syntax or plain string
click          "fire" | "inject" | "inject-send"    default "fire" (runs rule actions)
```

### `probability`

```
chance   number   0–100; default 50
```

Combine with `when: "all"` to make any rule probabilistic.

### `domEvent`

Fires when a DOM `CustomEvent` with a matching name is dispatched on `document`. The matched event name becomes `{{keyword}}`.

```
eventName   string   required; e.g. "plz:rmbg-done"
```

When the trigger fires, the event's `detail` object is unpacked into turn variables automatically: each field `foo` in `detail` becomes `{{dom_event_foo}}`. `{{dom_event_name}}` is always set to the event name. For example, a `plz:rmbg-done` event with `detail: { uuid, status, path, error }` populates `{{dom_event_uuid}}`, `{{dom_event_status}}`, `{{dom_event_path}}`, and `{{dom_event_error}}`.

Rules listening for a DOM event require the event listener to be registered. Triggeryze scans all enabled rules at startup and on chat change; newly added `domEvent` rules take effect without a page reload.

---

## Action types

All actions accept an optional `note` field.

### `stop`

**Stage: stream.** Halts generation immediately. Partial message is left as-is, keyword included. To also remove the keyword, add a separate `replace` rule targeting the same keyword with a blank replacement — this is the stop-and-strip pattern and requires two rules because stop and replace operate at different stages.

```
continue   boolean   default false; resumes generation after stopping so newly activated lorebook entries participate in the continued reply
```

### `replace`

**Stage: postMessage.** Replaces every occurrence of the matched keyword in the committed message.

```
replacement   string   replacement text; blank to delete; supports {{vars}}
```

### `call-llm`

**Stage: postMessage.**

```
prompt        string                                                                       required; supports {{vars}} and {{history:N[:filter]}}
output        "replace-keyword" | "replace-paragraph" | "append" | "insert" | "silent"   default "replace-keyword"
calls         "once" | "per-match"                                                        default "once"
var           string                                                                       save result to this turn variable
connection    string | null                                                                Connection Manager profile ID; null = main ST LLM
```

Output modes: `replace-keyword` replaces every keyword occurrence; `replace-paragraph` replaces the entire paragraph containing the keyword; `append` adds to the end of the message; `insert` inserts the result as a new AI message after the current one; `silent` discards output (use with `var` to capture the result in a turn variable).

The LLM call fires as soon as the keyword is detected during streaming, not after streaming ends — in most cases the result is ready by the time the message is committed.

### `compose`

**Stage: postMessage.** Evaluates a template and writes the result to a named turn variable. No LLM call.

```
var        string   required
template   string   required; supports {{vars}} and {{if}}…{{/if}}
```

### `slash-cmd`

**Stage: stream and postMessage.** Fires twice per turn by default — once during streaming and once after the message is committed. If your command reads `{{message}}` or sends messages, restrict it to postMessage by combining the rule with an `event` (MESSAGE_RECEIVED) trigger using `when: "all"`.

```
command   string   required; ST slash command; supports {{vars}}
var       string   save pipe result to this turn variable
```

### `update`

**Stage: postMessage.**

**Lorebook target** (`target: "lorebook"`, the default):

```
target     "lorebook"   write this explicitly to avoid ambiguity
lorebook   string       required; must exist as a file on disk; does not need to be active; supports {{vars}}
title      string       required; used to locate or create the entry; supports {{vars}}
keys       string       comma-separated trigger keys; merged on update; supports {{vars}}
content    string       entry body; supports {{vars}}
var        string       save entry title on success
```

If an entry with the given title exists, its content is replaced and new keys are merged in. If not found, a new entry is created. The lorebook file must already exist on disk — this action cannot create a lorebook from scratch. The lorebook does not need to be active in ST's World Info panel.

**Text target** (`target: "text"`):

```
target   "text"                                                             required
mode     "replace-keyword" | "replace-paragraph" | "append" | "insert"    default "replace-keyword"
value    string                                                             required; supports {{vars}}
var      string                                                             save written text
```

### `image`

**Stage: postMessage.** Returns immediately — generation runs in the background.

```
source      string    default "pollinations"
model       string    blank for source default
prompt      string    required; supports {{vars}} and {{history:N[:filter]}}
var         string    save uploaded image path
persist     boolean   save to chat file; default true
comfy-url   string    ComfyUI endpoint; only used when source is "comfy"
```

Valid `source` values: `pollinations` `fal` `bfl` `stability` `openai` `google` `together` `chutes` `electron-hub` `nanogpt` `xai` `zai` `aiml` `openrouter` `huggingface` `comfy`

### `set-var`

**Stage: postMessage.** Writes to an ST chat or global variable. Persists across turns.

```
scope   "chat" | "global"   default "chat"
var     string               required
key     string               optional; object key or array index — always a string (e.g. "0", not 0)
value   string               required; supports {{vars}}
```

### `domEvent`

**Stage: postMessage.** Dispatches a DOM `CustomEvent` on `document` with a JSON payload. All payload values support `{{vars}}` interpolation.

```
eventName   string   required; e.g. "plz:request-rmbg"
payload     string   required; JSON string; supports {{vars}}; default "{}"
```

Example payload for triggering Personalyze background removal:

```json
{"image":"personalyze/{{keyword}}.png","dir":"exports","uuid":"{{dom_event_uuid}}"}
```

### `load-image`

**Stage: stream and postMessage (idempotent).** Attaches a pre-existing image to the message gallery. Fires at both stages; an idempotency check on `msg.extra.media` prevents adding the same path twice.

```
path      string    required; path to image file; supports {{vars}}
var       string    save resolved path to this turn variable
persist   boolean   save to chat file and emit MESSAGE_UPDATED; default true
```

### `toast`

**Stage: stream and postMessage.** Pops a toastr notification in the SillyTavern UI.

```
message         string                                      required; notification body; supports {{vars}}
title           string                                      notification heading; supports {{vars}}; optional
level           "info" | "success" | "warning" | "error"   default "info"
tap-to-dismiss  boolean                                     click the toast to dismiss; default false
copy-on-click   boolean                                     click copies message to clipboard; default false
```

### `inject-preset`

**Stage: postMessage. Requires Chat Completion backend.** Creates or updates a named entry in ST's PromptManager, injecting persistent text above `chatHistory` in the prompt stack. Takes effect on the next generation. No-op if the PromptManager is unavailable (non-CC backend).

A toastr notification fires automatically the first time a named preset is created — this is unconditional and cannot be suppressed. On every chat load, if any TRG-owned presets exist in the current PromptManager, a second toastr lists them. Both notifications are deliberate visibility signals to prevent orphan prompts accumulating unnoticed.

```
name      string                          required; supports {{vars}}; resolved value is slugified to derive the prompt id (trg_preset_<slug>)
content   string                          prompt text injected into the stack; supports {{vars}}; write mode only
mode      "write" | "clear" | "remove"   default "write"
```

**Modes:**
- `write` — ensures the named prompt entry exists (creates if absent, fires toastr on creation), then writes the interpolated content
- `clear` — sets the prompt content to an empty string; the slot remains in the prompt order
- `remove` — removes the slot from the active character's prompt order and deletes the prompt definition entirely

**Note on name and ID stability.** The prompt id is derived from the *resolved* name. If `name` contains a variable that resolves to a different value each turn, each value creates its own slot. The chat-load audit and creation toastr make orphans visible.

---

## Template variables

Available in every `{{vars}}`-supporting field:

```
{{keyword}}                    matched keyword, regex capture, or trigger sentinel
{{up-to}}                      message text before the first keyword occurrence
{{paragraph}}                  paragraph containing the keyword
{{message}}                    full message text
{{history:2}}                  last 2 turn-pairs of chat history; bare N is always a literal
{{history:{{turns}}}}          last N turn-pairs where N comes from turn variable "turns"
{{history:2:user}}             last 2 user messages (exactly 2 matching messages, walking back)
{{history:2:ai}}               last 2 AI messages
{{history:2:Aria}}             last 2 messages from the speaker named Aria; * wildcard ({{history:2:Ja*}})
{{history:2:{{speaker}}}}      last 2 messages from the speaker named by turn variable "speaker"; glob supported
{{char}}                       character name
{{user}}                       user name
{{chat_id}}                    current chat file name without extension — stable per-chat identifier
{{highlighted}}                browser-selected text at badge click; empty for other triggers
{{varName}}                    turn variable scoped to the current group
{{$varName}}                   global turn variable — readable across all groups
{{lbTitles:lb:title:key:mode:scope}}   comma-separated entry titles from lorebook query
{{lbKeys:lb:title:key:mode:scope}}     comma-separated trigger keys from lorebook query
{{lbContent:lb:title:key:mode:scope}}  entry body from lorebook query
{{lbBooks:lb:title:key:mode:scope}}    lorebook names from lorebook query
{{psName:nameFilter:mode}}      slot names from the last generation's context stack
{{psContent:nameFilter:mode}}   slot content from the last generation's context stack
{{psRows:nameFilter}}           TSV data source: one `identifier\tcharCount` line per matching slot
{{chatvar::varName}}           ST chat variable
{{globalvar::varName}}         ST global variable
{{math: expr}}                 safe arithmetic after all substitution (e.g. {{math: {{hp}} + 10}}); supports rand() → float [0,1) and randint(N,M) → integer in [N,M]
```

`lb` args: all optional (empty = wildcard). Filter args (lb/title/key): bare text = literal; `{{varName}}` = turn variable; `A, B` = OR list; `!pattern` = exclude; `"quoted, text"` = literal containing a comma; `AND(a,b)` / `OR(a,b)` for explicit combinators. `mode`: `first | last | rnd | all` (default: `all` for titles/keys/books, `first` for content). `scope`: `active` (default) | `all` (every lorebook on disk) | `inactive`.

`ps` args: `nameFilter` optional. Forms: bare text = literal identifier or display name; `glob*` pattern; `{{varName}}` = turn variable; `!pattern` = exclude (e.g. `!chatHistory*`); `AND(a,b)` / `OR(a,b)` for multi-item combinators; `"quoted, literal"` protects commas. Mixed inclusions and exclusions supported. `mode`: `first | last | all`. Resolves postMessage only.

`{{psRows:nameFilter}}` supports an additional `:sub=` parameter to collapse matching rows into a single aggregate line: `:sub=matchFilter>label>sumFilter` replaces the first matching row with `label<TAB><total_chars>`. `sumFilter` may be a glob filter (e.g. `chatHistory-*`) or the special source `@oaiConvChars` (the windowed conversation character count from ST's itemizedPrompts snapshot).

`{{psMaxNameLen:nameFilter}}` — returns the character length of the longest display name among matching slots. Use to drive `{{pad:N:}}` width in `{{mapLines}}` bodies so columns align regardless of slot names in the active preset.

`{{psCharSum:nameFilter}}` — sums the character counts of all matching slots and emits the total as an integer. Use alongside `{{psRows:!chatHistory*}}` to add a rolled-up Chat History row with the real windowed character count.

`{{uuid}}` — generates a fresh v4 UUID on every call. Use a compose action to generate it once and store it, then reference the variable everywhere else that needs the same ID.

Map blocks — project a template over every row of tab-separated data:

```
{{mapLines: delimiter : source}}
{{.1}} and {{.2}} are column references
{{/mapLines}}
```

The **delimiter** is the character that separates columns in each row (`\t` for tab, `,` for comma, etc.). The **source** is where the data comes from: a turn variable name, `chatvar::name`, or `globalvar::name`. Inside the body, `{{.1}}` is the first column, `{{.2}}` is the second, and so on. Each row of the source becomes one line of output, so the result works naturally with a badge trigger's `split-on: "\\n"`.

```jsonc
// Context layer bar chart — dynamic, no hardcoded slot names
{ "type": "compose", "var": "ps_rows", "template": "{{psRows}}" },
{ "type": "compose", "var": "layer_bars", "template": "{{mapLines: \\t : ps_rows}}\n{{.1}} ({{bar: {{.2}} : 4000 : 20}})\n{{/mapLines}}" }
// badge trigger: label "{{layer_bars}}", split-on "\\n"

// Game stat bars from a structured chatvar
{ "type": "compose", "var": "stat_bars", "template": "{{mapLines: \\t : chatvar::stats}}\n{{.1}}: {{bar: {{.2}} : 10 : 20}}\n{{/mapLines}}" }
```

Conditional blocks (non-nestable):

```
{{if condition}}text{{/if}}
```

Operators: `matches "regex"`, `contains "text"`, `is "value"`, `in (a, b, c)`, `empty`
Combinators: `AND`, `OR`, `!`, `( )`

---

## Template transforms

Run after all `{{varName}}` substitution and `{{math:}}`. Inner variable references resolve first.

```
{{trim: val}}                strip leading/trailing whitespace and newlines
{{upper: val}}               uppercase
{{lower: val}}               lowercase
{{cap: val}}                 capitalize first character
{{len: val}}                 character count as a string
{{lines: N: val}}            first N lines
{{last: N: val}}             last N lines
{{nth: N: val}}              line N, 1-based; empty if out of range
{{words: N: val}}            first N whitespace-separated words
{{chars: N: val}}            first N characters
{{join: delim: val}}         join non-empty lines with delimiter
{{replace: find: with: val}} replace all occurrences of find with with (literal)
{{default: fallback: val}}   val if non-empty after trim, otherwise fallback
{{bar: value : bucketSize : max}}   colon bar chart — one ':' per full bucket, '.' if remainder > 20%, '+' on overflow
{{pick: N: val}}             N random non-empty lines from val, newline-joined; if val has fewer than N lines, returns all
```

```
{{trim: {{opts}}}}                          trim LLM output before badge splitting
{{lines: 4: {{opts}}}}                      first 4 lines of opts
{{last: 1: {{opts}}}}                       last line only
{{chars: 80: {{summary}}}}                  truncate to 80 characters
{{join: , : {{opts}}}}                      collapse lines to comma-separated
{{replace: [Char]: {{char}}: {{prompt}}}}   swap placeholder for character name
{{default: nothing yet: {{summary}}}}       fallback when summary is unset
```

`{{join:}}`: one optional leading space after `join:` is consumed as padding; rest is literal delimiter. `{{replace:}}` and `{{default:}}`: find/with/fallback may not contain a colon.

---

## Import behavior

1. Strip `//` and `/* */` comments
2. Detect shape by structure (see [File shapes](#file-shapes))
3. Auto-generate missing `id` on rulesets and rules
4. Default `enabled: true`, `when: "any"`
5. Map format type keys to internal registry keys
6. Warn (toast + console) on unknown types, bad enum values, missing required fields — broken triggers/actions are skipped; parent rule still imports

## Export behavior

1. Flat config, kebab type keys, `when` field, `rulesets` array
2. Preserve `note` fields
3. Include `id` on rulesets and rules
4. Omit `enabled` when true; omit optional fields at their default value
5. Ruleset export: top-level `rules` array

---

## Examples

Valid JSONC — save as `.json` and import via the Import button in the profile bar.

---

### Sentinel stop and strip

`stop` fires at stream stage; `replace` fires at postMessage. Two rules required — a single rule is bound to one stage.

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

Two sequential actions in one rule. `compose` writes the banned-phrase list to a turn variable; `call-llm` reads it via `{{banned}}`. Actions within a rule execute in order and share a variable store.

```jsonc
{
  "name": "Anti-slop",
  "rules": [
    {
      "name": "Rewrite cliché",
      "triggers": [
        {
          "type": "keyword",
          "use-regex": true,
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

Rule 1 fires after each AI message, calls the LLM silently, and stores four short continuation options in `opts`. Rule 2 renders `opts` as clickable bottom badges — one per line — that inject and send the selected option. `{{trim: {{opts}}}}` strips trailing blank lines before splitting, preventing empty badges.

```jsonc
{
  "name": "Continuation badges",
  "note": "After each message, generate four short continuation options and render them as clickable send buttons below the response.",
  "rules": [
    {
      "name": "Generate options",
      "note": "MESSAGE_RECEIVED fires postMessage. output:silent runs the LLM but writes nothing to the message — the result goes to opts instead. {{history:2}} expands to the previous 2 turn-pairs as context inline in the prompt.",
      "triggers": [
        { "type": "event", "event": "MESSAGE_RECEIVED" }
      ],
      "actions": [
        {
          "type": "call-llm",
          "output": "silent",
          "var": "opts",
          "prompt": "You are generating reply options for an ongoing roleplay. {{user}} is talking with {{char}}.\n\nRecent context:\n{{history:2}}\n\nLatest message from {{char}}:\n{{message}}\n\nGenerate exactly 4 short replies {{user}} might send next. Each must be under 15 words. Write from {{user}}'s point of view. Output only the 4 options, one per line, no numbering, no labels, no extra text."
        }
      ]
    },
    {
      "name": "Show option badges",
      "note": "{{trim: {{opts}}}} strips leading/trailing blank lines before split-on divides on newlines, preventing empty badges. click:inject-send submits the option when clicked.",
      "triggers": [
        {
          "type": "badge",
          "style": "bottom",
          "label": "{{trim: {{opts}}}}",
          "split-on": "\\n",
          "click": "inject-send"
        }
      ],
      "actions": []
    }
  ]
}
```
