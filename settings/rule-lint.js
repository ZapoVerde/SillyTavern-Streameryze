/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/rule-lint.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role IO — static, deterministic defect detection for rules
 * @description
 * Flags rule content that is guaranteed to misbehave regardless of runtime state — not
 * "might be wrong depending on timing" (that needs the ruleset-harness, see
 * docs/ruleset-harness.md), but "will never work no matter what the variables hold."
 * Four checks: a condition trigger clause no operator pattern can ever match; a variable
 * reference (template, var-match, or condition) to a name no action anywhere in scope ever
 * produces; a required action field that is a static empty literal with no {{...}} tokens
 * at all; and an outputVar that nothing else in scope ever reads. All four are checked
 * against the rule's actual visible scope (same ruleset for a bare name, any ruleset for a
 * $-prefixed global), reusing the same outputVar/reference conventions the engine and the
 * var-picker (actions/index.js's makeActionCtx) already use — this module adds no new
 * scoping rules of its own.
 *
 * Each flag names the specific trigger or action it belongs to (scope + index into
 * rule.triggers / rule.actions) so the UI can mark the exact offending row, not just the
 * rule as a whole.
 *
 * @api-declaration
 * lintRule(rule, rulesetId, allRulesets) → { scope: 'trigger'|'action', index: number, message: string }[]
 *
 * @contract
 *   assertions:
 *     purity:          pure — reads only the passed-in rule/ruleset data
 *     state_ownership: none
 *     external_io:     none
 */

import { findUnresolvedConditionText, extractConditionVarNames } from '../actions/condition.js';

const _REQUIRED_FIELDS = {
    update:       (cfg) => (cfg.target ?? 'lorebook') === 'lorebook' ? ['lorebook', 'title'] : [],
    preset:       () => ['name'],
    sideCall:     () => ['prompt'],
    image:        (cfg) => [(cfg.source ?? 'pollinations') === 'path' ? 'path' : 'prompt'],
    compose:      () => ['outputVar'],
    slashCmd:     () => ['command'],
    setStVar:     () => ['varName'],
    toast:        () => ['message'],
    switchPreset: () => ['preset'],
};

// ---------------------------------------------------------------------------
// Check 1 — condition clauses no operator pattern can ever match
// ---------------------------------------------------------------------------

function lintDeadConditions(rule) {
    const flags = [];
    (rule.triggers ?? []).forEach((t, index) => {
        if (t.type !== 'condition') return;
        const residue = findUnresolvedConditionText(t.config?.expression);
        if (residue) {
            flags.push({ scope: 'trigger', index,
                message: `Condition can never resolve — "${residue}" isn't a recognized clause (unquoted literal, or a variable reference missing {{...}}?).` });
        }
    });
    return flags;
}

// ---------------------------------------------------------------------------
// Shared: variable provenance and reference occurrences across the ruleset
// ---------------------------------------------------------------------------

function collectProducedVars(allRulesets) {
    const local  = new Map(); // rulesetId -> Set<name>
    const global = new Set();
    for (const rs of (allRulesets ?? [])) {
        const set = new Set();
        local.set(rs.id, set);
        for (const r of (rs.rules ?? [])) {
            for (const a of (r.actions ?? [])) {
                const v = a.config?.outputVar;
                if (!v) continue;
                (v.startsWith('$') ? global : set).add(v);
            }
        }
    }
    return { local, global };
}

// Built into every template's interpolation context (template.js) — never a user-declared
// outputVar, so a reference to one of these is never "unknown," no matter what scans the config.
const _BUILTIN_TEMPLATE_VARS = new Set([
    'keyword', 'message', 'up-to', 'paragraph', 'char', 'user', 'highlighted', 'chat_id', 'uuid',
]);

// Every {{varName}}/var-match/condition reference in a rule, with where it came from —
// used both to localize an unknown-var flag to a specific row and (via referencedNamesInRule
// below) to answer "is this var referenced ANYWHERE in rule R" for the dead-end-output check.
function collectReferenceOccurrences(rule) {
    const occurrences = [];
    (rule.actions ?? []).forEach((a, index) => {
        const text = Object.values(a.config ?? {}).filter(v => typeof v === 'string').join(' ');
        for (const m of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
            const name = m[1].trim();
            if (name.includes(':')) continue; // function-like token (lbTitles:, history:, math:, ...), not a var name
            if (_BUILTIN_TEMPLATE_VARS.has(name)) continue;
            // {{if <condition>}}...{{/if}} blocks — this non-nested-brace scan can't tell an
            // {{if}} open/close marker from a bare {{varName}}, so it treats "if <condition>"
            // as one opaque token rather than parsing the condition inside it. Excluding the
            // marker avoids false positives; a typo'd var name inside the condition itself
            // is not currently caught here.
            if (/^if\s+/i.test(name) || name === '/if') continue;
            occurrences.push({ name, scope: 'action', index });
        }
    });
    (rule.triggers ?? []).forEach((t, index) => {
        if (t.type === 'varMatch' && t.config?.varName) occurrences.push({ name: t.config.varName, scope: 'trigger', index });
        if (t.type === 'condition')
            for (const name of extractConditionVarNames(t.config?.expression)) occurrences.push({ name, scope: 'trigger', index });
    });
    return occurrences;
}

function referencedNamesInRule(rule) {
    return new Set(collectReferenceOccurrences(rule).map(o => o.name));
}

// ---------------------------------------------------------------------------
// Check 2 — reference to a variable nothing in scope ever produces
// ---------------------------------------------------------------------------

function lintUnknownVarRefs(rule, rulesetId, allRulesets) {
    const { local, global } = collectProducedVars(allRulesets);
    const inScope = new Set([...(local.get(rulesetId) ?? []), ...global]);

    // Cross-ruleset (non-$) refs are already flagged by detectOutOfScopeVars in
    // rule-cards.js — exclude them here so the same mistake isn't reported twice.
    const outOfScope = new Set();
    for (const [rsId, names] of local) {
        if (rsId === rulesetId) continue;
        for (const n of names) outOfScope.add(n);
    }

    const flags = [];
    const seen = new Set();
    for (const { name, scope, index } of collectReferenceOccurrences(rule)) {
        if (inScope.has(name) || outOfScope.has(name)) continue;
        const key = `${scope}:${index}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        flags.push({ scope, index,
            message: `"${name}" is never set by any action in this ruleset (or as a $global anywhere) — check for a typo, or a missing $ prefix.` });
    }
    return flags;
}

// ---------------------------------------------------------------------------
// Check 3 — required action field is a static empty literal
// ---------------------------------------------------------------------------

function lintStaticallyEmptyFields(rule) {
    const flags = [];
    (rule.actions ?? []).forEach((a, index) => {
        const getFields = _REQUIRED_FIELDS[a.type];
        if (!getFields) return;
        for (const field of getFields(a.config ?? {})) {
            const raw = a.config?.[field];
            if (typeof raw !== 'string') continue;
            if (raw.includes('{{')) continue; // could resolve to something at runtime
            if (!raw.trim()) {
                flags.push({ scope: 'action', index,
                    message: `"${field}" is empty with no {{...}} template — this will always fail or silently do nothing.` });
            }
        }
    });
    return flags;
}

// ---------------------------------------------------------------------------
// Check 4 — outputVar nothing else in scope ever reads
// ---------------------------------------------------------------------------

function lintDeadEndOutputs(rule, rulesetId, allRulesets) {
    const flags = [];
    const ownOutputs = (rule.actions ?? [])
        .map((a, index) => ({ name: a.config?.outputVar, index }))
        .filter(o => o.name);
    if (!ownOutputs.length) return flags;

    for (const { name, index } of ownOutputs) {
        const isGlobal = name.startsWith('$');
        // A bare name is only visible within its own ruleset; a $global is visible everywhere.
        // Both sets include this rule itself — a later sibling action reading the value counts
        // as "used" just as much as a downstream rule reading it.
        const candidateRules = isGlobal
            ? (allRulesets ?? []).flatMap(rs => rs.rules ?? [])
            : (allRulesets ?? []).find(rs => rs.id === rulesetId)?.rules ?? [];

        const used = candidateRules.some(r => referencedNamesInRule(r).has(name));
        if (!used) {
            flags.push({ scope: 'action', index,
                message: `Output "${name}" is never referenced anywhere else in scope — this work has no effect.` });
        }
    }
    return flags;
}

// ---------------------------------------------------------------------------

export function lintRule(rule, rulesetId, allRulesets) {
    return [
        ...lintDeadConditions(rule),
        ...lintUnknownVarRefs(rule, rulesetId, allRulesets),
        ...lintStaticallyEmptyFields(rule),
        ...lintDeadEndOutputs(rule, rulesetId, allRulesets),
    ];
}
