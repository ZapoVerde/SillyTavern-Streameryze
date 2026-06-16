# Triggeryze — Save Format

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

**Two stages per turn:**
- **Stream** — actions run as tokens arrive; single ordered pass. Only `stop` and `slash-cmd` are valid here.
- **postMessage** — actions run after the full message is committed; fixed-point loop. The engine iterates all unfired rules and repeats until a complete pass fires nothing new.

**Deduplication.** Each rule fires at most once per stage per turn. A rule bound to stream stage and a rule bound to postMessage stage can both match the same keyword in the same turn — this is intentional and is the basis of the stop-and-strip pattern.

**Turn variables.** Set by `compose` (`var` field) and `call-llm` (`var` field). Shared across all rules in the same turn — any rule can read what an earlier-firing rule wrote. Cleared at the start of each new generation. Distinct from `chatvar::` / `globalvar::` ST variables, which persist across turns.

**Cross-rule ordering.** At postMessage stage, rule order in the list does not affect correctness. A `var-match` rule listed before its upstream producer resolves on the next loop pass. Write rules around what they detect, not where they sit in the list. Stream stage is a single pass — order matters there.

---

## Trigger types

All triggers accept an optional `note` field.

### `keyword`

Matches one or more words anywhere in the response. Matched text → `{{keyword}}`.

```
keywords         string    required; comma-separated; * and ? wildcards; supports {{varName}} and lb query tokens
case-sensitive   boolean   default false
```

### `regex`

Full match (or first capture group) → `{{keyword}}`.

```
pattern   string   required; /pattern/flags syntax, or plain string for basic match
```

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
var        string                                                                               required
operator   "equals" | "not-equals" | "contains" | "matches" | "not-empty" | "set" | "not-set"   default "equals"
value      string                                                                               omit for "not-empty", "set", "not-set"
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
split-on       string                                delimiter to split label into multiple buttons; use \\n for newline, , for comma
keywords       string                                inline only: comma-separated keywords to wrap as clickable spans
case-sensitive boolean                               inline only; default false
click          "fire" | "inject" | "inject-send"    default "fire" (runs rule actions)
```

### `probability`

```
chance   number   0–100; default 50
```

Combine with `when: "all"` to make any rule probabilistic.

---

## Action types

All actions accept an optional `note` field.

### `stop`

**Stage: stream.** Halts generation immediately. Partial message is left as-is, keyword included. To also remove the keyword, add a separate `replace` rule targeting the same keyword with a blank replacement — this is the stop-and-strip pattern and requires two rules because stop and replace operate at different stages.

```
andContinue   boolean   default false; resumes generation after stopping so newly activated lorebook entries participate in the continued reply
```

### `replace`

**Stage: postMessage.** Replaces every occurrence of the matched keyword in the committed message.

```
replacement   string   replacement text; blank to delete; supports {{vars}}
```

### `call-llm`

**Stage: postMessage.**

```
prompt        string                                                                       required; supports {{vars}} and {{history:[N]}}
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
lorebook   string       required; must exist in ST's World Info panel; supports {{vars}}
title      string       required; used to locate or create the entry; supports {{vars}}
keys       string       comma-separated trigger keys; merged on update; supports {{vars}}
content    string       entry body; supports {{vars}}
var        string       save entry title on success
```

If an entry with the given title exists, its content is replaced and new keys are merged in. If not found, a new entry is created. The lorebook file itself must already exist in ST's World Info panel — this action cannot create a lorebook from scratch.

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
prompt      string    required; supports {{vars}} and {{history:[N]}}
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

---

## Template variables

Available in every `{{vars}}`-supporting field:

```
{{keyword}}                    matched keyword, regex capture, or trigger sentinel
{{up-to}}                      message text before the first keyword occurrence
{{paragraph}}                  paragraph containing the keyword
{{message}}                    full message text
{{history:[2]}}                last 2 turn-pairs of chat history; N is a literal in brackets
{{history:turns}}              last N turn-pairs where N comes from turn variable "turns"
{{char}}                       character name
{{user}}                       user name
{{highlighted}}                browser-selected text at badge click; empty for other triggers
{{varName}}                    value of a turn variable named varName
{{lbTitles:[lb]:[title]:[key]:[mode]:[scope]}}   comma-separated entry titles from lorebook query
{{lbKeys:[lb]:[title]:[key]:[mode]:[scope]}}     comma-separated trigger keys from lorebook query
{{lbContent:[lb]:[title]:[key]:[mode]:[scope]}}  entry body from lorebook query
{{lbBooks:[lb]:[title]:[key]:[mode]:[scope]}}    lorebook names from lorebook query
{{psName:[nameFilter]:[mode]}}      slot names from the last generation's context stack
{{psContent:[nameFilter]:[mode]}}   slot content from the last generation's context stack
{{chatvar::varName}}           ST chat variable
{{globalvar::varName}}         ST global variable
{{math: expr}}                 safe arithmetic after all substitution (e.g. {{math: {{hp}} + 10}})
```

`lb` args: all optional (empty = wildcard). `mode`: `first | last | all` (default: `all` for titles/keys/books, `first` for content). `scope`: `active` (default) | `all` (every lorebook on disk) | `inactive`.

`ps` args: `nameFilter` optional. Forms: `[identifier]` literal, `[Display Name]` literal, `glob*` pattern, bare turn-variable name. `mode`: `first | last | all`. Resolves postMessage only.

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
{{trim: val}}               strip leading/trailing whitespace and newlines
{{upper: val}}              uppercase
{{lower: val}}              lowercase
{{lines: N: val}}           first N lines
{{words: N: val}}           first N whitespace-separated words
{{default: fallback: val}}  val if non-empty after trim, otherwise fallback
```

```
{{trim: {{opts}}}}                     trim LLM output before badge splitting
{{lines: 4: {{opts}}}}                 first 4 lines of opts
{{default: nothing yet: {{summary}}}}  fallback when summary is unset
```

`{{default:}}`: fallback may not contain a colon.

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

Rule 1 fires after each AI message, calls the LLM silently, and stores four short continuation options in `opts`. Rule 2 renders `opts` as clickable bottom badges — one per line — that inject and send the selected option. `{{trim: {{opts}}}}` strips trailing blank lines before splitting, preventing empty badges.

```jsonc
{
  "name": "Continuation badges",
  "note": "After each message, generate four short continuation options and render them as clickable send buttons below the response.",
  "rules": [
    {
      "name": "Generate options",
      "note": "MESSAGE_RECEIVED fires postMessage. output:silent runs the LLM but writes nothing to the message — the result goes to opts instead. {{history:[2]}} expands to the previous 2 turn-pairs as context inline in the prompt.",
      "triggers": [
        { "type": "event", "event": "MESSAGE_RECEIVED" }
      ],
      "actions": [
        {
          "type": "call-llm",
          "output": "silent",
          "var": "opts",
          "prompt": "You are generating reply options for an ongoing roleplay. {{user}} is talking with {{char}}.\n\nRecent context:\n{{history:[2]}}\n\nLatest message from {{char}}:\n{{message}}\n\nGenerate exactly 4 short replies {{user}} might send next. Each must be under 15 words. Write from {{user}}'s point of view. Output only the 4 options, one per line, no numbering, no labels, no extra text."
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
