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
    'replace':        'update',
    'call-llm':       'sideCall',
    'compose':        'compose',
    'slash-cmd':      'slashCmd',
    'update':         'update',
    'load-image':     'image',
    'image':          'image',
    'set-var':        'setStVar',
    'toast':          'toast',
    'inject-preset':  'preset',
    'switch-preset':  'switchPreset',
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
    'prepend':           'prependToMessage',
    'append':            'appendToMessage',
    'replace':           'replaceMessage',
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
        if (mode === 'lorebook') return { mode: 'lorebook' };
        // match-mode field (new) takes precedence; legacy use-regex / mode:'regex' still import cleanly
        const matchMode = r['match-mode'] ?? ((r['use-regex'] || mode === 'regex') ? 'regex' : 'keyword');
        if (matchMode === 'regex') return { mode: 'text', matchMode: 'regex', pattern: r.pattern ?? '' };
        if (matchMode === 'fuzzy') return {
            mode: 'text', matchMode: 'fuzzy',
            keywords:       r.keywords ?? '',
            fuzzyThreshold: String(r['fuzzy-threshold'] ?? '80'),
        };
        return { mode: 'text', matchMode: 'keyword', keywords: r.keywords ?? '', caseSensitive: r['case-sensitive'] ?? false };
    },
    varMatch:      r => {
        let op       = _OP_I[r.operator] ?? r.operator ?? 'equals';
        let useRegex = r['use-regex'] ?? false;
        if (op === 'matches') { op = 'equals'; useRegex = true; }
        const out = { varName: r.var ?? '', operator: op, value: r.value ?? '' };
        if (useRegex) out.useRegex = true;
        if (op === 'fuzzy' && r['fuzzy-threshold'] !== undefined)
            out.fuzzyThreshold = String(r['fuzzy-threshold']);
        return out;
    },
    condition:     r => ({ expression: r.expression ?? '' }),
    badge:         r => {
        // match-mode field (new) takes precedence; legacy use-regex still imports cleanly for inline
        const matchMode = r['match-mode'] ?? (r['use-regex'] ? 'regex' : 'keyword');
        return {
            style:          r.style        ?? 'top',
            label:          r.label        ?? 'run',
            color:          r.color        ?? '#8888ff',
            graph:          r.graph        === true,
            splitOn:        r['split-on']  ?? '',
            matchMode,
            keywords:       r.keywords     ?? '',
            caseSensitive:  r['case-sensitive'] ?? false,
            pattern:        r.pattern      ?? '',
            fuzzyThreshold: String(r['fuzzy-threshold'] ?? '80'),
            clickAction:    r.click        ?? 'fire',
        };
    },
    chance:        r => ({ chance: r.chance ?? 50 }),
    event:         r => ({ event: r.event ?? 'MESSAGE_RECEIVED' }),
};

const ACTION_CFG_I = {
    stop:          r  => ({ andContinue: r.continue ?? false }),
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
        target:    r.type === 'replace' ? 'text' : (r.target ?? 'lorebook'),
        lorebook:  r.lorebook  ?? '',
        title:     r.title     ?? '',
        keys:      r.keys      ?? '',
        content:   r.content   ?? '',
        outputVar: r.var       ?? '',
        mode:      _TEXT_MODE_I[r.mode] ?? 'replaceKeyword',
        value:     r.value ?? r.replacement ?? '',
    }),
    image:         r => {
        if (r.type === 'load-image') return {
            source:     'path',
            path:       r.path    ?? '',
            model:      '',
            comfyUiUrl: '',
            prompt:     '{{keyword}}',
            outputVar:  r.var     ?? '',
            persist:    r.persist ?? true,
        };
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
            path:       '',
            outputVar:  r.var          ?? '',
            persist:    r.persist      ?? true,
        };
    },
    setStVar:      r => ({ scope: r.scope ?? 'chat', varName: r.var ?? '', key: r.key ?? '', value: r.value ?? '' }),
    toast:         r => ({
        level:        r.level        ?? 'info',
        message:      r.message      ?? '',
        title:        r.title        ?? '',
        tapToDismiss: r['tap-to-dismiss'] ?? false,
        copyOnClick:  r['copy-on-click']  ?? false,
    }),
    preset:        r => ({
        name:           r.name               ?? '',
        content:        r.content            ?? '',
        mode:           r.mode               ?? 'write',
        confirmCreate:  r['confirm-create']  ?? false,
        confirmDestroy: r['confirm-destroy'] ?? false,
        confirmUpdate:  r['confirm-update']  ?? false,
    }),
    switchPreset:  r => ({ preset: r.preset ?? '', outputVar: r.var ?? '' }),
};

// ---------------------------------------------------------------------------
// Per-type config exporters: (internal config {}) → flat format fields
// Keys are internal type names.
// ---------------------------------------------------------------------------

const TRIGGER_CFG_E = {
    keyword:      cfg => {
        const mode = cfg.mode ?? 'text';
        if (mode === 'lorebook') return { mode: 'lorebook' };
        // derive matchMode from new field or legacy useRegex
        const matchMode = cfg.matchMode ?? (cfg.useRegex ? 'regex' : 'keyword');
        if (matchMode === 'regex') return { 'match-mode': 'regex', pattern: cfg.pattern ?? '' };
        if (matchMode === 'fuzzy') {
            const out = { 'match-mode': 'fuzzy', keywords: cfg.keywords ?? '' };
            const t = parseInt(cfg.fuzzyThreshold ?? '80', 10);
            if (t !== 80) out['fuzzy-threshold'] = t;
            return out;
        }
        // keyword mode: omit 'mode' field so old format readers aren't surprised
        const out = { keywords: cfg.keywords ?? '' };
        if (cfg.caseSensitive) out['case-sensitive'] = true;
        return out;
    },
    varMatch:     cfg => {
        const _noVal = ['notEmpty', 'empty', 'set', 'notSet'];
        const op  = cfg.operator ?? 'equals';
        const out = { var: cfg.varName ?? '', operator: _OP_E[op] ?? op };
        if (!_noVal.includes(op)) {
            out.value = cfg.value ?? '';
            if (cfg.useRegex) out['use-regex'] = true;
            if (op === 'fuzzy') {
                const t = parseInt(cfg.fuzzyThreshold ?? '80', 10);
                if (t !== 80) out['fuzzy-threshold'] = t;
            }
        }
        return out;
    },
    condition:    cfg => ({ expression: cfg.expression ?? '' }),
    badge:        cfg => {
        const isInline = (cfg.style ?? 'top') === 'inline';
        const out = { style: cfg.style ?? 'top' };
        if (isInline) {
            out.color = cfg.color ?? '#8888ff';
            const matchMode = cfg.matchMode ?? (cfg.useRegex ? 'regex' : 'keyword');
            if (matchMode === 'regex') {
                out['match-mode'] = 'regex';
                out.pattern       = cfg.pattern ?? '';
            } else if (matchMode === 'fuzzy') {
                out['match-mode'] = 'fuzzy';
                out.keywords      = cfg.keywords ?? '';
                const t = parseInt(cfg.fuzzyThreshold ?? '80', 10);
                if (t !== 80) out['fuzzy-threshold'] = t;
            } else {
                out.keywords = cfg.keywords ?? '';
                if (cfg.caseSensitive) out['case-sensitive'] = true;
            }
        } else {
            out.label = cfg.label ?? 'run';
            out.color = cfg.color ?? '#8888ff';
            if (cfg.graph)   out.graph      = true;
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
    image:        cfg => {
        if ((cfg.source ?? 'pollinations') === 'path') {
            const out = { source: 'path', path: cfg.path ?? '' };
            if (cfg.outputVar)         out.var     = cfg.outputVar;
            if (cfg.persist === false) out.persist  = false;
            return out;
        }
        const out = { source: cfg.source ?? 'pollinations', prompt: cfg.prompt ?? '{{keyword}}' };
        if (cfg.model)             out.model        = cfg.model;
        if (cfg.outputVar)         out.var          = cfg.outputVar;
        if (cfg.persist === false) out.persist      = false;
        if (cfg.comfyUiUrl)        out['comfy-url'] = cfg.comfyUiUrl;
        return out;
    },
    setStVar:     cfg => {
        const out = { scope: cfg.scope ?? 'chat', var: cfg.varName ?? '', value: cfg.value ?? '' };
        if (cfg.key) out.key = cfg.key;
        return out;
    },
    toast:        cfg => {
        const out = { level: cfg.level ?? 'info', message: cfg.message ?? '' };
        if (cfg.title)        out.title = cfg.title;
        if (cfg.tapToDismiss) out['tap-to-dismiss'] = true;
        if (cfg.copyOnClick)  out['copy-on-click']  = true;
        return out;
    },
    preset:       cfg => {
        const out = { name: cfg.name ?? '' };
        if ((cfg.mode ?? 'write') !== 'write') out.mode = cfg.mode;
        if (cfg.content)        out.content           = cfg.content;
        if (cfg.confirmCreate)  out['confirm-create']  = true;
        if (cfg.confirmDestroy) out['confirm-destroy'] = true;
        if (cfg.confirmUpdate)  out['confirm-update']  = true;
        return out;
    },
    switchPreset: cfg => {
        const out = { preset: cfg.preset ?? '' };
        if (cfg.outputVar) out.var = cfg.outputVar;
        return out;
    },
};

// ---------------------------------------------------------------------------
// Per-type validators: (raw, warnings, ruleName) → boolean
// Return false to skip the trigger/action. Called after the type key lookup,
// before the config importer. Keys are internal type names.
// ---------------------------------------------------------------------------

function _req(raw, field, typeName, warnings, ruleName) {
    if (raw[field] == null) {
        warnings.push(`${_ruleLabel(ruleName)}: ${typeName} missing required field "${field}" — skipped`);
        return false;
    }
    return true;
}

function _enumVal(raw, field, valid, typeName, warnings, ruleName) {
    const val = raw[field];
    if (val != null && !valid.has(val)) {
        warnings.push(`${_ruleLabel(ruleName)}: ${typeName} has unknown ${field} "${val}" — skipped (valid: ${[...valid].join(', ')})`);
        return false;
    }
    return true;
}

const _VALID_EVENTS       = new Set(['MESSAGE_RECEIVED', 'GENERATION_STARTED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'CHAT_LOADED']);
const _VALID_BADGE_STYLES = new Set(['top', 'bottom', 'inline']);
const _VALID_BADGE_CLICKS = new Set(['fire', 'inject', 'inject-send']);
const _VALID_SCOPES       = new Set(['chat', 'global']);

const TRIGGER_VALIDATORS = {
    keyword:   (raw, w, rn) => {
        const mode      = raw.mode ?? 'text';
        if (mode === 'lorebook') return true;
        const matchMode = raw['match-mode'] ?? ((raw['use-regex'] || mode === 'regex') ? 'regex' : 'keyword');
        if (matchMode === 'regex') return _req(raw, 'pattern', 'keyword (regex)', w, rn);
        return _req(raw, 'keywords', 'keyword', w, rn);
    },
    varMatch:  (raw, w, rn) => _req(raw, 'var',        'var-match',  w, rn),
    condition: (raw, w, rn) => _req(raw, 'expression', 'condition',  w, rn),
    event:     (raw, w, rn) => _enumVal(raw, 'event', _VALID_EVENTS, 'event', w, rn),
    badge:     (raw, w, rn) =>
        _enumVal(raw, 'style', _VALID_BADGE_STYLES, 'badge', w, rn) &&
        _enumVal(raw, 'click', _VALID_BADGE_CLICKS, 'badge', w, rn),
    chance:    (raw, w, rn) => {
        const c = raw.chance;
        if (c != null && (typeof c !== 'number' || c < 0 || c > 100)) {
            w.push(`${_ruleLabel(rn)}: probability chance must be a number 0–100 (got "${c}") — skipped`);
            return false;
        }
        return true;
    },
};

const ACTION_VALIDATORS = {
    sideCall:  (raw, w, rn) => _req(raw, 'prompt',   'call-llm',  w, rn),
    compose:   (raw, w, rn) => _req(raw, 'var',      'compose',   w, rn) && _req(raw, 'template', 'compose',  w, rn),
    slashCmd:  (raw, w, rn) => _req(raw, 'command',  'slash-cmd', w, rn),
    image:     (raw, w, rn) => raw.type === 'load-image'
        ? _req(raw, 'path',   'image (path)',     w, rn)
        : _req(raw, 'prompt', 'image (generate)', w, rn),
    setStVar:  (raw, w, rn) =>
        _req(raw, 'var',   'set-var', w, rn) &&
        _req(raw, 'value', 'set-var', w, rn) &&
        _enumVal(raw, 'scope', _VALID_SCOPES, 'set-var', w, rn),
    update:    (raw, w, rn) => {
        if (raw.type === 'replace') return true; // legacy key: maps to text/replaceKeyword, no required fields
        if ((raw.target ?? 'lorebook') === 'text')
            return _req(raw, 'value',    'update (text)',     w, rn);
        return _req(raw, 'lorebook', 'update (lorebook)', w, rn) &&
               _req(raw, 'title',    'update (lorebook)', w, rn);
    },
    preset:        (raw, w, rn) => _req(raw, 'name',   'inject-preset', w, rn),
    switchPreset:  (raw, w, rn) => _req(raw, 'preset', 'switch-preset', w, rn),
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
    if (TRIGGER_VALIDATORS[ikey] && !TRIGGER_VALIDATORS[ikey](raw, warnings, ruleName)) return null;
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
    if (ACTION_VALIDATORS[ikey] && !ACTION_VALIDATORS[ikey](raw, warnings, ruleName)) return null;
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
