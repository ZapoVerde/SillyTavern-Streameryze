/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/format.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role IO — v2 format translation (import/export boundary)
 * @description
 * Pure translation between the v2 public JSON format and the internal settings
 * representation. No DOM, jQuery, or extension_settings dependencies.
 *
 * The v2 format is human-readable and LLM-friendly:
 *   - Type keys match UI labels (kebab-case): "call-llm", "keyword", "set-var", etc.
 *   - Config fields are flat — no config:{} wrapper
 *   - Field names are human-readable ("var", "output", "calls"), not internal
 *     ("outputVar", "outputMode", "callMode")
 *   - JSONC comments (// and block) are stripped before parse
 *   - note fields on any object are preserved through round-trips
 *
 * @api-declaration
 * stripJsonc(text)                       — strip // and /* comments before JSON.parse
 * detectShape(data)                      — 'profile'|'ruleset'|'rule'|'array'|'rule-v1'|'profile-v1'|null
 * parseAndImport(text, makeId)           — full import pipeline → { shape, rulesets?, rule?, warnings[] }
 * importTrigger(raw, warnings, ruleName) — translate one format trigger → internal
 * importAction(raw, warnings, ruleName)  — translate one format action → internal
 * importRule(raw, makeId, warnings)      — translate one format rule → internal
 * importRuleset(raw, makeId, warnings)   — translate one format ruleset → internal
 * exportTrigger(trigger)                 — translate internal trigger → format (flat)
 * exportAction(action)                   — translate internal action → format (flat)
 * exportRule(rule)                       — translate internal rule → v2 format
 * exportRuleset(ruleset)                 — translate internal ruleset → v2 format
 * exportProfile(name, rulesets)          — build complete v2 profile export object
 *
 * @contract
 *   assertions:
 *     purity:          pure — no side effects; all warnings returned, none thrown
 *     state_ownership: none
 *     external_io:     none
 */

// ---------------------------------------------------------------------------
// JSONC stripping
// ---------------------------------------------------------------------------

export function stripJsonc(text) {
    let out = '';
    let i   = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '"') {
            out += ch; i++;
            while (i < n) {
                const c = text[i]; out += c; i++;
                if (c === '\\') { if (i < n) { out += text[i++]; } }
                else if (c === '"') break;
            }
        } else if (ch === '/' && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n') i++;
        } else if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
        } else {
            out += ch; i++;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Type key maps — format (kebab) ↔ internal (camelCase registry keys)
// ---------------------------------------------------------------------------

const TRIGGER_KEY_MAP = {
    'keyword':        'keyword',
    'var-match':      'varMatch',
    'condition':      'condition',
    'badge':          'badge',
    'probability':    'chance',
    'event':          'event',
};
const ACTION_KEY_MAP = {
    'stop':           'stop',
    'replace':        'replace',
    'call-llm':       'sideCall',
    'compose':        'compose',
    'slash-cmd':      'slashCmd',
    'update':         'update',
    'image':          'imageGen',
    'set-var':        'setStVar',
};

// Reverse maps (internal → format) derived from above
const TRIGGER_KEY_EXPORT = _invert(TRIGGER_KEY_MAP);
const ACTION_KEY_EXPORT  = _invert(ACTION_KEY_MAP);

// ---------------------------------------------------------------------------
// Enum value maps
// ---------------------------------------------------------------------------

const _OUT_MODE_I = {
    'replace-keyword':   'replaceKeyword',
    'replace-paragraph': 'replaceParagraph',
    'append':            'appendToMessage',
    'insert':            'insertMessage',
    'silent':            'silent',
};
const _OUT_MODE_E = _invert(_OUT_MODE_I);

const _CALL_MODE_I  = { 'once': 'once', 'per-match': 'perMatch' };
const _CALL_MODE_E  = _invert(_CALL_MODE_I);

const _TEXT_MODE_I  = {
    'replace-keyword':   'replaceKeyword',
    'replace-paragraph': 'replaceParagraph',
    'append':            'appendToMessage',
    'insert':            'insertMessage',
};
const _TEXT_MODE_E = _invert(_TEXT_MODE_I);

const _OP_I = { 'not-empty': 'notEmpty', 'not-equals': 'notEquals', 'not-set': 'notSet' };
const _OP_E = { 'notEmpty': 'not-empty', 'notEquals': 'not-equals', 'notSet': 'not-set' };

// ---------------------------------------------------------------------------
// Per-type config importers: (flat format object) → internal config {}
// Keys are internal type names (after TRIGGER_KEY_MAP / ACTION_KEY_MAP lookup).
// ---------------------------------------------------------------------------

const TRIGGER_CFG_I = {
    keyword:       r => {
        const mode = r.mode ?? 'text';
        if (mode === 'lorebook') return { mode };
        if (mode === 'regex')    return { mode, pattern: r.pattern ?? '' };
        return { mode: 'text', keywords: r.keywords ?? '', caseSensitive: r['case-sensitive'] ?? false };
    },
    varMatch:      r => ({
        varName:  r.var ?? '',
        operator: _OP_I[r.operator] ?? r.operator ?? 'equals',
        value:    r.value ?? '',
    }),
    condition:     r => ({ expression: r.expression ?? '' }),
    badge:         r => ({
        style:         r.style        ?? 'top',
        label:         r.label        ?? 'run',
        color:         r.color        ?? '#8888ff',
        splitOn:       r['split-on']  ?? '',
        keywords:      r.keywords     ?? '',
        caseSensitive: r['case-sensitive'] ?? false,
        clickAction:   r.click        ?? 'fire',
    }),
    chance:        r => ({ chance: r.chance ?? 50 }),
    event:         r => ({ event: r.event ?? 'MESSAGE_RECEIVED' }),
};

const ACTION_CFG_I = {
    stop:          r  => ({ andContinue: r.continue ?? false }),
    replace:       r => ({ replacement: r.replacement ?? '' }),
    sideCall:      r => {
        // Migrate legacy history: N field → inline {{history:[N]}} token in prompt.
        // If the prompt already uses {{history:...}} the field is ignored — inline wins.
        let prompt = r.prompt ?? '';
        const legacyN = r.history ?? 0;
        if (legacyN > 0 && !prompt.includes('{{history:'))
            prompt = prompt.replace(/\{\{history\}\}/g, `{{history:[${legacyN}]}}`);
        return {
            prompt,
            outputMode: _OUT_MODE_I[r.output] ?? 'replaceKeyword',
            callMode:   _CALL_MODE_I[r.calls] ?? 'once',
            outputVar:  r.var        ?? '',
            profileId:  r.connection ?? null,
        };
    },
    compose:       r => ({ outputVar: r.var ?? '', template: r.template ?? '' }),
    slashCmd:      r => ({ command: r.command ?? '', outputVar: r.var ?? '' }),
    update:        r => ({
        target:    r.target    ?? 'lorebook',
        lorebook:  r.lorebook  ?? '',
        title:     r.title     ?? '',
        keys:      r.keys      ?? '',
        content:   r.content   ?? '',
        outputVar: r.var       ?? '',
        mode:      _TEXT_MODE_I[r.mode] ?? 'replaceKeyword',
        value:     r.value     ?? '',
    }),
    imageGen:      r => {
        // Migrate legacy history: N field → inline {{history:[N]}} token in prompt.
        let prompt = r.prompt ?? '{{keyword}}';
        const legacyN = r.history ?? 0;
        if (legacyN > 0 && !prompt.includes('{{history:'))
            prompt = prompt.replace(/\{\{history\}\}/g, `{{history:[${legacyN}]}}`);
        return {
            source:     r.source       ?? 'pollinations',
            model:      r.model        ?? '',
            comfyUiUrl: r['comfy-url'] ?? '',
            prompt,
            outputVar:  r.var          ?? '',
            persist:    r.persist      ?? true,
        };
    },
    setStVar:      r => ({ scope: r.scope ?? 'chat', varName: r.var ?? '', key: r.key ?? '', value: r.value ?? '' }),
};

// ---------------------------------------------------------------------------
// Per-type config exporters: (internal config {}) → flat format fields
// Keys are internal type names.
// ---------------------------------------------------------------------------

const TRIGGER_CFG_E = {
    keyword:      cfg => {
        const mode = cfg.mode ?? 'text';
        if (mode === 'lorebook') return { mode: 'lorebook' };
        if (mode === 'regex')    return { mode: 'regex', pattern: cfg.pattern ?? '' };
        // text mode: omit 'mode' field so old format readers aren't surprised
        const out = { keywords: cfg.keywords ?? '' };
        if (cfg.caseSensitive) out['case-sensitive'] = true;
        return out;
    },
    varMatch:     cfg => {
        const _noVal = ['notEmpty', 'set', 'notSet'];
        const op  = cfg.operator ?? 'equals';
        const out = { var: cfg.varName ?? '', operator: _OP_E[op] ?? op };
        if (!_noVal.includes(op)) out.value = cfg.value ?? '';
        return out;
    },
    condition:    cfg => ({ expression: cfg.expression ?? '' }),
    badge:        cfg => {
        const isInline = (cfg.style ?? 'top') === 'inline';
        const out = { style: cfg.style ?? 'top' };
        if (isInline) {
            out.keywords = cfg.keywords ?? '';
            out.color    = cfg.color    ?? '#8888ff';
            if (cfg.caseSensitive) out['case-sensitive'] = true;
        } else {
            out.label = cfg.label ?? 'run';
            out.color = cfg.color ?? '#8888ff';
            if (cfg.splitOn) out['split-on'] = cfg.splitOn;
        }
        if ((cfg.clickAction ?? 'fire') !== 'fire') out.click = cfg.clickAction;
        return out;
    },
    chance:       cfg => ({ chance: cfg.chance ?? 50 }),
    event:        cfg => ({ event: cfg.event ?? 'MESSAGE_RECEIVED' }),
};

const ACTION_CFG_E = {
    stop:         cfg => cfg.andContinue ? { continue: true } : {},
    replace:      cfg => ({ replacement: cfg.replacement ?? '' }),
    sideCall:     cfg => {
        const out = { prompt: cfg.prompt ?? '' };
        const mode = _OUT_MODE_E[cfg.outputMode] ?? 'replace-keyword';
        if (mode !== 'replace-keyword') out.output = mode;
        const calls = _CALL_MODE_E[cfg.callMode] ?? 'once';
        if (calls !== 'once') out.calls = calls;
        if (cfg.outputVar) out.var = cfg.outputVar;
        if (cfg.profileId)    out.connection = cfg.profileId;
        return out;
    },
    compose:      cfg => ({ var: cfg.outputVar ?? '', template: cfg.template ?? '' }),
    slashCmd:     cfg => {
        const out = { command: cfg.command ?? '' };
        if (cfg.outputVar) out.var = cfg.outputVar;
        return out;
    },
    update:       cfg => {
        const isText = (cfg.target ?? 'lorebook') === 'text';
        const out    = { target: cfg.target ?? 'lorebook' };
        if (cfg.outputVar) out.var = cfg.outputVar;
        if (isText) {
            const mode = _TEXT_MODE_E[cfg.mode] ?? 'replace-keyword';
            if (mode !== 'replace-keyword') out.mode = mode;
            out.value = cfg.value ?? '';
        } else {
            out.lorebook = cfg.lorebook ?? '';
            out.title    = cfg.title    ?? '';
            if (cfg.keys) out.keys = cfg.keys;
            out.content  = cfg.content  ?? '';
        }
        return out;
    },
    imageGen:     cfg => {
        const out = { source: cfg.source ?? 'pollinations', prompt: cfg.prompt ?? '{{keyword}}' };
        if (cfg.model)     out.model = cfg.model;
        if (cfg.outputVar) out.var   = cfg.outputVar;
        if (cfg.persist === false) out.persist = false;
        if (cfg.comfyUiUrl)   out['comfy-url'] = cfg.comfyUiUrl;
        return out;
    },
    setStVar:     cfg => {
        const out = { scope: cfg.scope ?? 'chat', var: cfg.varName ?? '', value: cfg.value ?? '' };
        if (cfg.key) out.key = cfg.key;
        return out;
    },
};

// ---------------------------------------------------------------------------
// Import functions
// ---------------------------------------------------------------------------

export function importTrigger(raw, warnings, ruleName = '') {
    if (!raw || typeof raw !== 'object') {
        warnings.push(`${_ruleLabel(ruleName)}: trigger is not an object — skipped`);
        return null;
    }
    const fmt  = raw.type;
    const ikey = TRIGGER_KEY_MAP[fmt];
    if (!ikey) {
        warnings.push(`${_ruleLabel(ruleName)}: unknown trigger type "${fmt}" — skipped (valid: ${Object.keys(TRIGGER_KEY_MAP).join(', ')})`);
        return null;
    }
    const config  = (TRIGGER_CFG_I[ikey] ?? (() => ({})))(raw);
    const trigger = { type: ikey, config };
    if (raw.note) trigger.note = raw.note;
    return trigger;
}

export function importAction(raw, warnings, ruleName = '') {
    if (!raw || typeof raw !== 'object') {
        warnings.push(`${_ruleLabel(ruleName)}: action is not an object — skipped`);
        return null;
    }
    const fmt  = raw.type;
    const ikey = ACTION_KEY_MAP[fmt];
    if (!ikey) {
        warnings.push(`${_ruleLabel(ruleName)}: unknown action type "${fmt}" — skipped (valid: ${Object.keys(ACTION_KEY_MAP).join(', ')})`);
        return null;
    }
    const config = (ACTION_CFG_I[ikey] ?? (() => ({})))(raw);
    const action = { type: ikey, config };
    if (raw.note) action.note = raw.note;
    return action;
}

export function importRule(raw, makeId, warnings) {
    if (!raw || typeof raw !== 'object') return null;
    const name     = raw.name ?? '';
    const triggers = (raw.triggers ?? []).map(t => importTrigger(t, warnings, name)).filter(Boolean);
    const actions  = (raw.actions  ?? []).map(a => importAction(a,  warnings, name)).filter(Boolean);
    const rule     = { id: raw.id ?? makeId(), name, enabled: raw.enabled ?? true, when: raw.when ?? 'any', triggers, actions };
    if (raw.note) rule.note = raw.note;
    return rule;
}

export function importRuleset(raw, makeId, warnings) {
    if (!raw || typeof raw !== 'object') return null;
    const rules = (raw.rules ?? []).map(r => importRule(r, makeId, warnings)).filter(Boolean);
    const rs    = { id: raw.id ?? makeId(), name: raw.name ?? '', enabled: raw.enabled ?? true, rules };
    if (raw.note) rs.note = raw.note;
    return rs;
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

export function detectShape(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data))                                                     return 'array';
    if (Array.isArray(data.rulesets))                                            return 'profile';
    if (Array.isArray(data.triggers) && Array.isArray(data.actions))            return 'rule';
    if (data.type === 'rule'    && data.rule && Array.isArray(data.rule.triggers)) return 'rule-v1';
    if (data.type === 'profile' && Array.isArray(data.rules))                   return 'profile-v1';
    if (Array.isArray(data.rules)   && !data.rulesets)                          return 'ruleset';
    return null;
}

// ---------------------------------------------------------------------------
// Top-level import entry point
// ---------------------------------------------------------------------------

/**
 * Parses JSONC text, detects file shape, and translates into internal objects.
 * Returns { shape, name?, rulesets?, rule?, warnings[] }.
 * Never throws — errors surface as warnings with shape: null.
 */
export function parseAndImport(text, makeId) {
    const warnings = [];
    let data;
    try {
        data = JSON.parse(stripJsonc(text));
    } catch (err) {
        return { shape: null, warnings: [`Could not parse JSON: ${err.message}`] };
    }

    const shape = detectShape(data);

    if (shape === 'profile') {
        const rulesets = (data.rulesets ?? []).map(rs => importRuleset(rs, makeId, warnings)).filter(Boolean);
        return { shape: 'profile', name: data.name ?? null, rulesets, warnings };
    }
    if (shape === 'ruleset') {
        const rs = importRuleset(data, makeId, warnings);
        return { shape: 'ruleset', rulesets: rs ? [rs] : [], warnings };
    }
    if (shape === 'rule') {
        const rule = importRule(data, makeId, warnings);
        return { shape: 'rule', rule, warnings };
    }
    if (shape === 'array') {
        const rs = importRuleset({ rules: data }, makeId, warnings);
        return { shape: 'ruleset', rulesets: rs ? [rs] : [], warnings };
    }
    // Legacy v1 — rule is already in internal format (config wrapper, camelCase keys)
    if (shape === 'rule-v1') {
        const raw  = data.rule;
        const rule = {
            id:       raw.id ?? makeId(),
            name:     raw.name ?? '',
            enabled:  raw.enabled ?? true,
            when:     raw.when ?? raw.triggerLogic ?? 'any',
            triggers: raw.triggers ?? [],
            actions:  raw.actions  ?? [],
        };
        return { shape: 'rule', rule, warnings };
    }
    // Legacy v1 — profile with flat rules array in internal format
    if (shape === 'profile-v1') {
        const rs = { id: makeId(), name: data.name ?? 'Default', enabled: true, rules: data.rules ?? [] };
        return { shape: 'profile', name: data.name ?? null, rulesets: [rs], warnings };
    }

    return { shape: null, warnings: ['Could not detect file shape. Expected: profile (rulesets[]), ruleset (rules[]), or rule (triggers[] + actions[]).'] };
}

// ---------------------------------------------------------------------------
// Export functions
// ---------------------------------------------------------------------------

export function exportTrigger(trigger) {
    if (!trigger) return null;
    const fmtType = TRIGGER_KEY_EXPORT[trigger.type];
    if (!fmtType) return null;
    const flat = (TRIGGER_CFG_E[trigger.type] ?? (() => ({})))(trigger.config ?? {});
    const out  = { type: fmtType, ...flat };
    if (trigger.note) out.note = trigger.note;
    return out;
}

export function exportAction(action) {
    if (!action) return null;
    const fmtType = ACTION_KEY_EXPORT[action.type];
    if (!fmtType) return null;
    const flat = (ACTION_CFG_E[action.type] ?? (() => ({})))(action.config ?? {});
    const out  = { type: fmtType, ...flat };
    if (action.note) out.note = action.note;
    return out;
}

export function exportRule(rule) {
    if (!rule) return null;
    const out = {};
    if (rule.id)            out.id      = rule.id;
    if (rule.name)          out.name    = rule.name;
    if (rule.enabled === false) out.enabled = false;
    if (rule.when && rule.when !== 'any') out.when = rule.when;
    if (rule.note)          out.note    = rule.note;
    out.triggers = (rule.triggers ?? []).map(exportTrigger).filter(Boolean);
    out.actions  = (rule.actions  ?? []).map(exportAction ).filter(Boolean);
    return out;
}

export function exportRuleset(ruleset) {
    if (!ruleset) return null;
    const out = { version: 2, type: 'ruleset' };
    if (ruleset.name)           out.name    = ruleset.name;
    if (ruleset.id)             out.id      = ruleset.id;
    if (ruleset.enabled === false) out.enabled = false;
    if (ruleset.note)           out.note    = ruleset.note;
    out.rules = (ruleset.rules ?? []).map(exportRule).filter(Boolean);
    return out;
}

export function exportProfile(name, rulesets) {
    return {
        version:  2,
        type:     'profile',
        name,
        rulesets: (rulesets ?? []).map(rs => {
            const out = exportRuleset(rs);
            if (out) { delete out.version; delete out.type; }
            return out;
        }).filter(Boolean),
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _ruleLabel(name) { return name ? `Rule "${name}"` : 'Rule'; }
function _invert(obj)     { return Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k])); }
