# Triggeryze

**[WIP]**

## Make AI generation reactive

Triggeryze watches generation output and user interaction, evaluates rules in real time, and routes matches to SillyTavern capabilities. A rule can:

* Detect keywords, regex patterns, lorebook entries, or variables
* Stop generation instantly
* Rewrite paragraphs automatically
* Run background LLM calls
* Generate images
* Execute SillyTavern slash commands
* Create or update lorebook entries
* Store values in turn-scoped variables that subsequent steps and other rules can read
* Create clickable buttons on AI messages that launch workflows on demand

The result is an AI that can react to its own output.

---

## Why Triggeryze exists

Normally, an AI response is just text. The model writes something, you read it, and anything worth acting on (a new character name, a clichéd phrase, a scene worth illustrating) gets dealt with by hand. You paste the name into your lorebook, you hit imagine, you edit out the slop. Triggeryze automates that loop. The response becomes an event stream: rules fire as the text arrives, state accumulates, new rules become eligible, and workflows emerge, all while the model keeps writing.

---

## Real examples

### Automatic anti-slop editing

If you're tired of breath hitching and catching, shaky breaths, stone-dropped-into-water metaphors, and your model's specific clichés, write a regex rule:

```text
WHEN:
    regex = breath hitch|breath catch|...

THEN:
    rewrite paragraph
```

The rewrite begins the moment the phrase appears in the stream. In most cases the replacement paragraph is already ready before the response finishes. Your model keeps going; Triggeryze quietly acts as an editor.

---

### Dynamic name replacement

The AI writes:

```text
Elara Voss entered the room.
```

A rule detects the restricted name, sends the surrounding context to a background LLM, and swaps in a replacement that fits the scene. No regeneration, no manual editing, no prompt engineering.

---

### Scene-aware image generation

The AI writes:

```text
Rain hammered against the tavern windows.
```

A regex catches the weather language. A background LLM reads the scene and saves `scene_weather = rain`. Another rule reacts to that variable and generates an image automatically. The image wasn't triggered by a keyword. It was triggered by an interpretation of what the AI actually meant.

---

## Custom message actions

Not every workflow needs to be automatic. Any rule can create a clickable badge button that appears on AI messages, letting you launch workflows on demand:

```text
[ Generate Portrait ]   [ Save Character ]   [ Expand Scene ]
[ Summarize ]           [ Critique Writing ]  [ Create Lorebook Entry ]
```

Badge-triggered workflows can do anything automatic workflows can: call an LLM, generate images, execute slash commands, write lorebook entries. They give you a custom toolbox built directly into every message. Automatic and manual workflows compose naturally: a rule can trigger on a keyword and also expose a badge button, so the same workflow runs automatically when it can and manually when you need it.

---

### Self-building lorebooks

The AI introduces a new character. You select the name in the message and click a badge button:

```text
[ Gen Entry ]
```

`{{highlighted}}` carries the selected text. A background LLM reads the last two turns of history plus the current message and generates a lorebook entry for that subject. A second action writes it directly to your lorebook. Select a name, click once, done.

---

## Rules compose without wiring

Rules don't need to be explicitly connected. One rule publishes information; others react when that information appears:

```text
Rule A: Detect weather → Save as: weather
Rule B: weather = rain → Generate image
Rule C: weather = rain → Generate ambience
Rule D: weather = storm → Generate encounter
```

Triggeryze re-evaluates rules continuously as new state appears. Complex workflows emerge from simple dependencies: no flowcharts, no node editor, no manual dependency management.

---

## Core capabilities

### Triggers

* Keyword match
* Regex match
* Lorebook keyword match
* Variable match
* Chat complete
* Badge button click

Combine triggers with AND / OR logic.

---

### Actions

* Stop generation
* Stop and continue generation
* Replace text
* Call LLM
* Compose variables
* Generate images
* Execute slash commands
* Create or update lorebook entries

Actions can be chained and share information through variables.

---

### Real-time processing

Many actions begin the moment a trigger appears during streaming, enabling live paragraph rewriting, anti-slop editing, background LLM enrichment, dynamic lore injection, and mid-generation classification without waiting for the response to finish.

---

### Dynamic lorebooks

* Read lorebook content directly in prompts
* Create entries automatically
* Update entries automatically
* Feed LLM output directly into world information
* Build lorebooks that grow alongside the story

---

### Deep SillyTavern integration

SillyTavern's slash command ecosystem is vast: hundreds of built-in commands, plus every extension that registers its own. Triggeryze can run any of them when a rule fires. That means any extension with a slash command API becomes a Triggeryze action instantly, with no dedicated integration needed. Trigger a background image change when a location keyword appears. Pipe an LLM classification into `/setvar` and make it available to other extensions. Call a Quick Reply. Read ST state and branch on the result. The output of any command captures into a variable, feeding the next action in the chain. The entire ST toolchain becomes part of your rules.

---

## The core idea

The AI says something, that becomes an event, rules react, new information is created, more rules become eligible. The response evolves while it's still being generated. Or you click a badge and launch a workflow yourself. Either way, the generation process becomes something you can program.

That's Triggeryze.

---

## Installation

1. Open SillyTavern.
2. Open Extensions.
3. Click **Install Extension**.
4. Paste the repository URL.
5. Enable Triggeryze.

---

## Documentation

See the [User Guide](docs/user-guide.md) for a full reference on triggers, actions, variables, templates, profiles, and lorebook integration.

---

## Generate rules with an LLM

The fastest way to build a ruleset is to describe what you want to a language model and let it write the JSON.

1. Open [docs/trg_save_format.md](docs/trg_save_format.md) and copy the entire file.
2. Paste it into your LLM of choice as context.
3. Describe the rule you want in plain language — what should trigger it, what should happen, what variables it should produce or consume.
4. The LLM writes a valid JSON ruleset. Copy it, save it as a `.json` file, and import it via the **Import** button in the profile bar.

The save format doc contains the complete schema, every trigger and action type with all their fields, template variable reference, and working examples. It is written to be consumed by an LLM: type keys match what the UI shows, fields are flat and readable, and `note` fields on every object give the model space to record intent alongside config. Comments in the JSON are stripped on import, so the LLM can annotate freely.
