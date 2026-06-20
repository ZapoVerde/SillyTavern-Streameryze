# Triggeryze — Project Principles
*Read before writing any code. Applies to every session.*

---

## What a Principle Is

**A principle is an enduring statement of design intent.** It says what must be true and why it matters — not how it is currently implemented. A principle should survive a complete rewrite: if you could achieve the same property by different means, the principle still holds.

**A principle is not:** a description of specific functions or file paths, a code recipe, a static analysis rule, or implementation documentation. When a principle references code by name, that code illustrates the principle in action — it is not the principle itself.

If you find yourself writing "call X" or "wrap in Y", move that detail into code comments or documentation. The principle captures the *why*.

---

## What Triggeryze Is

Triggeryze is a **reactive router**. Users build rules that watch generation output and user interaction, then route detected events to ST capabilities: stopping generation, mutating text, calling an LLM, writing lorebook entries, generating images, executing slash commands.

Triggeryze coordinates these capabilities; it does not own or implement them. Its scope is detection, wiring, and the lightweight state that connects steps within a turn. When a capability requires deep domain knowledge — image generation backends, complex lorebook management, video, audio — that belongs in a specialist extension. The slash command action is the explicit bridge to that world: any ST capability or extension that exposes a slash command API becomes reachable from a Triggeryze rule with no additional integration.

It is not a content filter, a narrative manager, or a message editor. It does not decide what to do with content — the user's rule list does. The extension exists only to evaluate those rules and dispatch to the appropriate handlers.

The engine is framework-first: triggers and actions live in registries. Adding a new trigger or action type means adding an entry to the appropriate registry. No other file changes.

---

## 1. The Rule List is the Only Source of Truth

Triggeryze has no opinions about what keywords matter or what should happen when they appear. All behaviour is fully determined by the user's saved rule list.

A session with no rules must produce exactly the same chat as a session without Triggeryze installed.

---

## 2. Disabling is Total

When Triggeryze is disabled, it must be as if it is not installed. No rules fire. No messages are mutated. No generations are stopped. No LLM calls are triggered.

This is not a courtesy — it is a correctness requirement. A disabled extension that still acts is a bug.

---

## 3. Action Type Determines Generation Stage — This Is Not Configurable

Every action type declares the stage at which it is valid: **stream** (the live generation is active) or **postMessage** (the final message has been committed). A small number of action types are valid at both stages when their behaviour is meaningful at either point.

Stage is an inherent property of the action type, determined by what the action needs from the generation lifecycle. It is not configurable per-rule. Moving an action to a different stage to solve an edge case is wrong — fix the action, not its stage.

---

## 4. Deduplication is Per {Rule, Stage}, Not Per Keyword

Within a single generation, a given rule fires at most once per stage (stream or postMessage). Deduplication resets at the start of every new turn. Triggeryze has no cross-turn memory.

The dedup key is `{ruleId}:{stage}`, not the matched keyword. This is deliberate: it allows a stop rule and a replace rule that share a trigger keyword to both fire in the same turn — stop at stream stage, replace at postMessage stage.

**The dedup ceiling is fixed at 1 and is not configurable.**

---

## 5. Turn Variables Are the Only State Between Actions — and Between Rules

Each generation creates a fresh variable store, cleared at the start of the turn and available until the next turn begins. Actions write values into it; subsequent actions in the same rule chain can read them. But the store is also shared across all rules within a turn, enabling cross-rule reactive composition: Rule A detects weather language and writes `weather = rain`; Rules B and C trigger on `weather = rain` and generate an image and an ambience track respectively.

Cross-rule chains work because postMessage evaluation runs as a fixed-point loop — the engine iterates through all unfired rules and repeats until a complete pass fires nothing new. A rule that misses on the first pass because its dependency variable hasn't been written yet will catch it on the next pass. Rule order in the list does not affect correctness at postMessage stage. The stream stage is a single pass with no retry, so cross-rule variable dependencies there are order-sensitive — but stream actions rarely participate in variable chains.

This store is explicitly ephemeral. Anything that needs to survive across turns — a character trait, a relationship state, a running count — belongs in a lorebook entry, an ST variable (`/setvar`), or state managed by another extension. Code that treats turn variables as durable storage has misunderstood their purpose.

---

## 6. Each Action Has One Responsibility

An action does exactly one thing. Stop halts the stream. Replace mutates the committed message. They do not compose into each other or clean up after each other.

This is what makes them composable: a user who wants "stop and strip" creates two rules. A user who only wants one effect creates one rule. Combining responsibilities inside an action type would silently remove that choice.

---

## 7. The Lorebook Trigger Observes; Lorebook Actions Act

The lorebook keyword trigger reads keyword definitions from the active lorebooks at the start of each generation. It does not maintain its own keyword list and does not influence which entries activate — it only observes. The lorebook is the source of truth for what keywords matter; the trigger is a read-only consumer of that information. Any code that writes to a lorebook entry or influences WI scanning as a side effect of this trigger has broken this principle.

Lorebook *actions* are a separate concern and are full members of Triggeryze's domain. Reading entries, creating entries, updating entries, deleting entries, and listing what exists in a lorebook are all in scope. The lorebook is a natural reactive write target: rules detect things in the generation and write them into world information. This is a first-class capability, not a side feature.

---

## 8. Actions Route to Capabilities They Do Not Own

Each action type is a thin coordination layer over an ST capability. Stop wraps generation control. Replace wraps message mutation. Call LLM wraps quiet prompt dispatch. Image generation wraps ST's image pipeline. Lorebook entry wraps world information write. The action owns the wiring; it does not own the capability.

This is the scope boundary. Triggeryze stays deliberately surface-level in each domain. It does not implement image generation backends. It does not manage lorebook structure. It does not run multi-step LLM pipelines internally. For anything deeper than a single coordinated step, the slash command action is the bridge: any extension that exposes a slash command becomes reachable from a rule without any change to Triggeryze.

A new action type belongs in Triggeryze when the underlying capability already exists in ST, the action can be configured in a single step, and the result can be expressed as text, a variable, or a direct message mutation. An action that goes deeper into a domain Triggeryze already touches is a signal to extract that domain into a specialist extension.

---

## 9. Verbose Logging is the Diagnostic Protocol

Rules engines are opaque by default: when something does not fire — or fires unexpectedly — there is no visible trail. Verbose mode is the answer to "why did that happen?"

When verbose is enabled, every rule evaluation produces a log entry: what keyword was tested, whether it matched, what action was taken or skipped and why. This must be sufficient to reconstruct the full decision path from the log alone, without access to the source.

Verbose is off by default. Silent operation is correct operation when nothing is wrong.

---

## 10. The Three Kinds of Code

Every module in Triggeryze belongs to exactly one of three categories. Mixing them is a defect.

1. **Registry** — each trigger or action does exactly one thing. Triggers read text and return a match or null. Actions produce one side effect. No cross-entry logic lives in either registry.
2. **Engine** — evaluates the rule list and dispatches to registry entries. Decides *when* to act; registries decide *how*. Owns no business logic beyond matching and dedup.
3. **Orchestrator** — wires events to the engine and renders the settings panel. The panel is UI scaffolding: it reads settings into the DOM and writes DOM values back to settings. It contains no rule evaluation.

Utility modules that serve multiple registry entries do not belong to any of the three categories above. They declare themselves as **IO** (utility modules; the `@contract.external_io` field distinguishes whether external systems are touched) or **UI** (DOM-rendering modules not part of the Orchestrator). They live in named utility files, not inside Orchestrator or Registry files.

---

## 11. Every Module is Self-Describing

Every source file opens with a structured preamble declaring its role, its public surface, and its contracts. This is not documentation — it is a forcing function. A module whose role cannot be stated clearly in a preamble has not been designed clearly enough to be implemented. Write the preamble first.

The `@architectural-role` field must name one of the roles from Principle 10, or `IO` / `UI` for utility modules, followed by a one-line description of what the module specifically owns or does. A compound role (e.g. `IO Wrapper + Registry`) is a warning sign: the file is probably doing two things and should be two files.

The `@stamp` field records the UTC timestamp of the last intentional architectural change — not the last edit. It is updated when the role, API surface, or contracts change; not when logic inside an existing function changes.

```javascript
/**
 * @file {path}
 * @stamp {"utc":"{iso timestamp}"}
 * @architectural-role {Registry | Engine | Orchestrator | IO | UI} — {one line describing what this module owns or does}
 * @description
 * {Two to four sentences. What problem does this module solve? What is it not responsible for?}
 *
 * @api-declaration
 * exportedName(args) — what it does and what it returns
 *
 * @contract
 *   assertions:
 *     purity:          {classification}
 *     state_ownership: [{state variables owned, or none}]
 *     external_io:     [{external systems touched, or none}]
 */
```

---

## 12. One Registry Entry, One File — Registries Assemble, Not Implement

Every action and trigger is a named, bounded unit before any code exists. The registry architecture makes this explicit: each entry has a type key, a declared stage, a config spec, and an execute function. These boundaries are the fault lines. They are not discovered when a file grows too large; they are given by the design.

Each non-trivial action or trigger implementation lives in its own file. A registry module imports those files and assembles the registry object. It contains no execute logic of its own. If logic moves into the registry module, it has escaped its correct file.

Shared machinery that serves multiple registry entries — template interpolation, LLM dispatch wiring, prefetch coordination — lives in named utility modules that declare their role in a preamble. It does not live in entry files (which would then export it sideways) or in the registry module (which would become an implementation file in disguise).

300 lines remains a ceiling. If a single action file reaches it, the action is doing more than one thing — extract the secondary concern into a utility module. But a file can be wrong at 80 lines if it contains two entries. Size is a trailing indicator; the registry boundary is the primary constraint.

---

## 13. Every User-Facing String Field Resolves Variable References

Every string field that a user may configure — labels, keywords, colors, prompts, template values, split delimiters — replaces `{{varName}}` tokens with the corresponding turn variable value before the field is used. This is not a per-field opt-in; it is a system-wide contract.

Fields that genuinely cannot support interpolation (structural enum selects, internal identifiers) must explicitly document the exception. The default is interpolation: any string a user can type is a potential template.

This principle means users can drive any string field from LLM output stored in a turn variable. A label field reading `{{options}}` and a split delimiter of `\n` produces one badge per line of LLM output with no additional configuration.

---

## 14. The Save Format Mirrors the UI

A user who can read the settings panel should be able to read a saved ruleset file without a translator. Type keys in the format are kebab-case renderings of the labels shown in the UI — `call-llm` not `sideCall`, `keyword` not `keywordMatch`. The format is the public surface; internal registry keys are an implementation detail that never appears in files the user touches.

The translation between format keys and registry keys lives entirely at the import/export boundary. Nothing else in the system knows about it. Code that leaks a registry key into the save format, or reads a format key directly from settings, has broken this boundary.

This principle has a corollary: **import failures must be visible and named.** A rule that loads but silently does nothing is harder to diagnose than a rule that fails with a clear error. Unknown type keys, wrong enum values, and missing required fields each produce a specific warning naming the problem, the location, and the valid alternatives. Silent acceptance of broken input is a bug.

The `note` field on rulesets, rules, triggers, and actions exists so that authors — including LLMs generating rulesets — can record intent alongside configuration. When a rule misfires, the note is the first thing to read: does the stated intent match what the config actually does? A system where the author's reasoning is preserved in the file is a system where debugging starts with reading, not guessing.

---

## 15. Tests Cover Logic, Not the UI

The settings panel is scaffolding — it reads state into the DOM and writes DOM values back to state. It contains no logic (Principle 10). A test that validates DOM state is testing that the framework renders, not that Triggeryze is correct. There is nothing to unit-test in UI code, and adding tests there would only paper over a violation of Principle 11 if logic had migrated into the panel.

What the test suite covers instead:

**Unit tests** verify a single registry entry in isolation. A trigger test asserts that a given input returns a match or null. An action test asserts that a given config produces the correct side effect with no other entries involved. If a unit test requires stubbing multiple concerns, the entry under test is doing too much.

**Round-trip tests** drive a constructed rule config through the full evaluation pipeline against a fixture input and assert the output: matched text, variable state, which actions fired. They verify that engine, registries, and variable store compose correctly without exposing implementation details of any individual part. Round-trip tests own the seams — unit tests own the entries.

**End-to-end tests** run against a real (or minimal real) ST environment: ST is up, the extension is loaded, a chat produces a generation, and the test asserts observable results. E2E tests own the integration boundaries that round-trip tests cannot reach: ST event hooks, host message writes, and the actual dedup lifecycle across a turn.

A gap at the unit or round-trip level is a design signal. If an entry is hard to test in isolation, it has undeclared dependencies. If a round-trip test requires excessive setup, the engine has hidden coupling.
