# Triggeryze

**[WIP]**

Triggeryze watches the AI's response and fires actions when keywords appear. It can stop the response mid-stream, replace words, run a background LLM call, generate an image, and chain the results of one action into the next — all driven by a list of rules you configure in the settings panel.

---

## What you get

**Automated cleanup.** Stop the AI from writing past a sentinel, strip it afterward, and resume without lifting a finger.

**Inline enrichment.** Fire a background LLM call the moment a keyword appears. By the time streaming ends, the result is usually already written into the message.

**Lorebook-aware triggers.** Fire rules when the AI writes any keyword from your active lorebooks — without maintaining a separate keyword list.

**Composable actions.** Stack actions in a single rule and pipe the output of one into the prompt of the next.

**On-demand buttons.** Attach a labeled button to any AI message. Click it to run a specific rule against that message whenever you want, independent of what the AI wrote.

**Cross-rule chaining.** A variable set by one rule can drive trigger conditions in the next — build multi-step decision trees across rules within the same turn.

---

## Installation

1. Open SillyTavern and click the **Extensions** icon (puzzle piece).
2. Click **Install extension**.
3. Paste the repository URL and confirm.
4. Triggeryze appears in the extensions list. Enable it from its settings panel.

---

## Documentation

- [User Guide](docs/user-guide.md) — triggers, actions, variables, templates, profiles, and everything else
