import { describe, it, expect } from 'vitest';
import {
    stripJsonc, detectShape, parseAndImport,
    importTrigger, importAction, importRule, importRuleset,
    exportTrigger, exportAction, exportRule, exportRuleset, exportProfile,
} from '../settings/format.js';

const id = () => 'test-id';

// ---------------------------------------------------------------------------
// stripJsonc
// ---------------------------------------------------------------------------

describe('stripJsonc', () => {
    it('leaves plain JSON unchanged', () => {
        const s = '{"a":1}';
        expect(JSON.parse(stripJsonc(s))).toEqual({ a: 1 });
    });
    it('strips // line comments', () => {
        const s = '{"a":1} // comment\n';
        expect(JSON.parse(stripJsonc(s))).toEqual({ a: 1 });
    });
    it('strips /* block comments */', () => {
        const s = '{ /* block */ "a": 1 }';
        expect(JSON.parse(stripJsonc(s))).toEqual({ a: 1 });
    });
    it('does not strip // inside strings', () => {
        const s = '{"url":"http://example.com"}';
        expect(JSON.parse(stripJsonc(s))).toEqual({ url: 'http://example.com' });
    });
    it('handles escaped quotes inside strings', () => {
        const s = '{"s":"say \\"hi\\""}';
        expect(JSON.parse(stripJsonc(s))).toEqual({ s: 'say "hi"' });
    });
});

// ---------------------------------------------------------------------------
// detectShape
// ---------------------------------------------------------------------------

describe('detectShape', () => {
    it('detects profile (rulesets[])', () => expect(detectShape({ rulesets: [] })).toBe('profile'));
    it('detects ruleset (rules[])',    () => expect(detectShape({ rules: [] })).toBe('ruleset'));
    it('detects rule (triggers+actions)', () => expect(detectShape({ triggers: [], actions: [] })).toBe('rule'));
    it('detects array',                () => expect(detectShape([])).toBe('array'));
    it('detects legacy rule-v1',       () => expect(detectShape({ type: 'rule', rule: { triggers: [], actions: [] } })).toBe('rule-v1'));
    it('detects legacy profile-v1',    () => expect(detectShape({ type: 'profile', rules: [] })).toBe('profile-v1'));
    it('returns null for unknown',     () => expect(detectShape({ foo: 'bar' })).toBeNull());
});

// ---------------------------------------------------------------------------
// importTrigger
// ---------------------------------------------------------------------------

describe('importTrigger', () => {
    it('translates keyword trigger (text mode)', () => {
        const w = [];
        const t = importTrigger({ type: 'keyword', keywords: 'dragon', 'case-sensitive': true }, w, 'R1');
        expect(t).toEqual({ type: 'keyword', config: { mode: 'text', matchMode: 'keyword', keywords: 'dragon', caseSensitive: true } });
        expect(w).toHaveLength(0);
    });
    it('translates keyword trigger (use-regex) — legacy field maps to matchMode:regex', () => {
        const w = [];
        const t = importTrigger({ type: 'keyword', 'use-regex': true, pattern: '/dragon/i' }, w);
        expect(t?.config).toEqual({ mode: 'text', matchMode: 'regex', pattern: '/dragon/i' });
        expect(w).toHaveLength(0);
    });
    it('translates keyword match-mode:fuzzy', () => {
        const w = [];
        const t = importTrigger({ type: 'keyword', 'match-mode': 'fuzzy', keywords: 'Tavern', 'fuzzy-threshold': 75 }, w);
        expect(t?.config).toEqual({ mode: 'text', matchMode: 'fuzzy', keywords: 'Tavern', fuzzyThreshold: '75' });
        expect(w).toHaveLength(0);
    });
    it('translates old keyword mode:regex to matchMode:regex', () => {
        const w = [];
        const t = importTrigger({ type: 'keyword', mode: 'regex', pattern: '/foo/' }, w);
        expect(t?.config).toEqual({ mode: 'text', matchMode: 'regex', pattern: '/foo/' });
        expect(w).toHaveLength(0);
    });
    it('warns on removed legacy type chat-complete', () => {
        const w = [];
        const t = importTrigger({ type: 'chat-complete' }, w);
        expect(t).toBeNull();
        expect(w[0]).toContain('"chat-complete"');
    });
    it('warns on removed legacy type lb-keyword', () => {
        const w = [];
        const t = importTrigger({ type: 'lb-keyword' }, w);
        expect(t).toBeNull();
        expect(w[0]).toContain('"lb-keyword"');
    });
    it('warns on removed legacy type regex', () => {
        const w = [];
        const t = importTrigger({ type: 'regex', pattern: '/dragon/i' }, w);
        expect(t).toBeNull();
        expect(w[0]).toContain('"regex"');
    });
    it('translates var-match trigger with field and operator renames', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'mood', operator: 'not-empty' }, w);
        expect(t?.config).toMatchObject({ varName: 'mood', operator: 'notEmpty' });
        expect(w).toHaveLength(0);
    });
    it('translates var-match not-equals operator', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'hp', operator: 'not-equals', value: '0' }, w);
        expect(t?.config).toMatchObject({ varName: 'hp', operator: 'notEquals', value: '0' });
        expect(w).toHaveLength(0);
    });
    it('translates var-match not-set operator', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'flag', operator: 'not-set' }, w);
        expect(t?.config).toMatchObject({ varName: 'flag', operator: 'notSet' });
        expect(w).toHaveLength(0);
    });
    it('passes set operator through unchanged', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'flag', operator: 'set' }, w);
        expect(t?.config).toMatchObject({ varName: 'flag', operator: 'set' });
        expect(w).toHaveLength(0);
    });
    it('passes empty operator through unchanged', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'summary', operator: 'empty' }, w);
        expect(t?.config).toMatchObject({ varName: 'summary', operator: 'empty' });
        expect(w).toHaveLength(0);
    });
    it('translates var-match with fuzzy operator and threshold', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'loc', operator: 'fuzzy', value: 'Tavern', 'fuzzy-threshold': 75 }, w);
        expect(t?.config).toMatchObject({ varName: 'loc', operator: 'fuzzy', value: 'Tavern', fuzzyThreshold: '75' });
        expect(w).toHaveLength(0);
    });
    it('translates var-match with use-regex', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'hp', operator: 'equals', value: '^\\d+$', 'use-regex': true }, w);
        expect(t?.config).toMatchObject({ varName: 'hp', operator: 'equals', value: '^\\d+$', useRegex: true });
        expect(w).toHaveLength(0);
    });
    it('migrates old var-match matches operator to equals + useRegex', () => {
        const w = [];
        const t = importTrigger({ type: 'var-match', var: 'hp', operator: 'matches', value: '^\\d+$' }, w);
        expect(t?.config).toMatchObject({ varName: 'hp', operator: 'equals', value: '^\\d+$', useRegex: true });
        expect(w).toHaveLength(0);
    });
    it('translates probability → chance internal key', () => {
        const w = [];
        const t = importTrigger({ type: 'probability', chance: 30 }, w);
        expect(t?.type).toBe('chance');
        expect(t?.config.chance).toBe(30);
    });
    it('translates event trigger', () => {
        const w = [];
        const t = importTrigger({ type: 'event', event: 'GENERATION_STARTED' }, w);
        expect(t?.type).toBe('event');
        expect(t?.config.event).toBe('GENERATION_STARTED');
    });
    it('warns on unknown type and returns null', () => {
        const w = [];
        const t = importTrigger({ type: 'nope' }, w, 'R1');
        expect(t).toBeNull();
        expect(w[0]).toContain('"nope"');
    });
    it('preserves note field', () => {
        const w = [];
        const t = importTrigger({ type: 'keyword', keywords: 'x', note: 'intent' }, w);
        expect(t?.note).toBe('intent');
    });
    it('translates badge with split-on and click fields', () => {
        const w = [];
        const t = importTrigger({ type: 'badge', style: 'top', label: 'Go', 'split-on': ',', click: 'inject' }, w);
        expect(t?.config.splitOn).toBe(',');
        expect(t?.config.clickAction).toBe('inject');
    });
});

// ---------------------------------------------------------------------------
// importAction
// ---------------------------------------------------------------------------

describe('importAction', () => {
    it('translates call-llm action with all field renames', () => {
        const w = [];
        const a = importAction({
            type: 'call-llm', prompt: 'hi', output: 'append', calls: 'per-match',
            var: 'result', connection: 'prof1',
        }, w);
        expect(a?.type).toBe('sideCall');
        expect(a?.config).toMatchObject({
            prompt: 'hi', outputMode: 'appendToMessage', callMode: 'perMatch',
            outputVar: 'result', profileId: 'prof1',
        });
        expect(w).toHaveLength(0);
    });

    it('migrates legacy history: N field by injecting {{history:[N]}} into prompt', () => {
        const w = [];
        const a = importAction({
            type: 'call-llm', prompt: 'Context: {{history}} Now: {{message}}', history: 3,
        }, w);
        expect(a?.config.prompt).toBe('Context: {{history:[3]}} Now: {{message}}');
        expect(a?.config).not.toHaveProperty('historyTurns');
    });

    it('migration no-ops when prompt has no {{history}} to replace', () => {
        const w = [];
        const a = importAction({ type: 'call-llm', prompt: 'no history token', history: 2 }, w);
        expect(a?.config.prompt).toBe('no history token');
    });

    it('migration skips when prompt already uses {{history:...}} inline form', () => {
        const w = [];
        const a = importAction({
            type: 'call-llm', prompt: '{{history:[5]}} existing', history: 3,
        }, w);
        expect(a?.config.prompt).toBe('{{history:[5]}} existing');
    });
    it('translates compose var→outputVar', () => {
        const w = [];
        const a = importAction({ type: 'compose', var: 'myVar', template: 'hello' }, w);
        expect(a?.config).toMatchObject({ outputVar: 'myVar', template: 'hello' });
    });
    it('translates slash-cmd var→outputVar', () => {
        const w = [];
        const a = importAction({ type: 'slash-cmd', command: '/set x', var: 'out' }, w);
        expect(a?.type).toBe('slashCmd');
        expect(a?.config).toMatchObject({ command: '/set x', outputVar: 'out' });
    });
    it('translates set-var var→varName', () => {
        const w = [];
        const a = importAction({ type: 'set-var', var: 'hp', scope: 'chat', value: '10', key: 'stats' }, w);
        expect(a?.type).toBe('setStVar');
        expect(a?.config).toMatchObject({ varName: 'hp', scope: 'chat', value: '10', key: 'stats' });
    });
    it('translates image comfy-url→comfyUiUrl and migrates history field', () => {
        const w = [];
        const a = importAction({ type: 'image', source: 'comfy', 'comfy-url': 'http://local', history: 2, prompt: '{{history}} cat' }, w);
        expect(a?.type).toBe('image');
        expect(a?.config.comfyUiUrl).toBe('http://local');
        expect(a?.config.prompt).toBe('{{history:[2]}} cat');
        expect(a?.config).not.toHaveProperty('historyTurns');
    });
    it('load-image format key imports as image with source:path', () => {
        const w = [];
        const a = importAction({ type: 'load-image', path: 'img/scene.png' }, w);
        expect(a?.type).toBe('image');
        expect(a?.config.source).toBe('path');
        expect(a?.config.path).toBe('img/scene.png');
        expect(w).toHaveLength(0);
    });
    it('translates update text mode values', () => {
        const w = [];
        const a = importAction({ type: 'update', target: 'text', mode: 'replace-paragraph', value: 'x' }, w);
        expect(a?.config.mode).toBe('replaceParagraph');
    });
    it('warns on unknown action type', () => {
        const w = [];
        const a = importAction({ type: 'vaporize' }, w, 'R1');
        expect(a).toBeNull();
        expect(w[0]).toContain('"vaporize"');
    });
    it('stop has andContinue:false by default', () => {
        const w = [];
        expect(importAction({ type: 'stop' }, w)?.config).toEqual({ andContinue: false });
        expect(w).toHaveLength(0);
    });
    it('stop with continue:true sets andContinue', () => {
        const w = [];
        expect(importAction({ type: 'stop', continue: true }, w)?.config).toEqual({ andContinue: true });
        expect(w).toHaveLength(0);
    });
    it('warns on removed legacy type stop-continue', () => {
        const w = [];
        const a = importAction({ type: 'stop-continue' }, w);
        expect(a).toBeNull();
        expect(w[0]).toContain('"stop-continue"');
    });
    it('translates switch-preset with preset and optional var', () => {
        const w = [];
        const a = importAction({ type: 'switch-preset', preset: 'Fight Scene', var: '$prev' }, w);
        expect(a?.type).toBe('switchPreset');
        expect(a?.config).toEqual({ preset: 'Fight Scene', outputVar: '$prev' });
        expect(w).toHaveLength(0);
    });
    it('switch-preset defaults outputVar to empty when var is absent', () => {
        const w = [];
        const a = importAction({ type: 'switch-preset', preset: 'Comfy 2' }, w);
        expect(a?.config.outputVar).toBe('');
        expect(w).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// importTrigger — field validation
// ---------------------------------------------------------------------------

describe('importTrigger — field validation', () => {
    it('keyword text: missing keywords → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'keyword' }, w)).toBeNull();
        expect(w[0]).toContain('keywords');
    });
    it('keyword text: present keywords passes', () => {
        const w = [];
        expect(importTrigger({ type: 'keyword', keywords: 'x' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('keyword regex: missing pattern → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'keyword', mode: 'regex' }, w)).toBeNull();
        expect(w[0]).toContain('pattern');
    });
    it('keyword regex: present pattern passes', () => {
        const w = [];
        expect(importTrigger({ type: 'keyword', mode: 'regex', pattern: '/x/i' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('keyword lorebook: no required fields', () => {
        const w = [];
        expect(importTrigger({ type: 'keyword', mode: 'lorebook' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('var-match: missing var → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'var-match' }, w)).toBeNull();
        expect(w[0]).toContain('"var"');
    });
    it('condition: missing expression → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'condition' }, w)).toBeNull();
        expect(w[0]).toContain('expression');
    });
    it('event: unknown event value → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'event', event: 'BOGUS' }, w)).toBeNull();
        expect(w[0]).toContain('"BOGUS"');
    });
    it('event: absent event field passes (defaults to MESSAGE_RECEIVED)', () => {
        const w = [];
        expect(importTrigger({ type: 'event' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('badge: invalid style → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'badge', style: 'sideways' }, w)).toBeNull();
        expect(w[0]).toContain('"sideways"');
    });
    it('badge: invalid click → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'badge', click: 'explode' }, w)).toBeNull();
        expect(w[0]).toContain('"explode"');
    });
    it('probability: out-of-range chance → warn + null', () => {
        const w = [];
        expect(importTrigger({ type: 'probability', chance: 150 }, w)).toBeNull();
        expect(w[0]).toContain('0–100');
    });
    it('probability: absent chance passes (defaults to 50)', () => {
        const w = [];
        expect(importTrigger({ type: 'probability' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// importAction — field validation
// ---------------------------------------------------------------------------

describe('importAction — field validation', () => {
    it('call-llm: missing prompt → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'call-llm' }, w)).toBeNull();
        expect(w[0]).toContain('prompt');
    });
    it('call-llm: present prompt passes', () => {
        const w = [];
        expect(importAction({ type: 'call-llm', prompt: 'go' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('compose: missing var → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'compose', template: 'x' }, w)).toBeNull();
        expect(w[0]).toContain('"var"');
    });
    it('compose: missing template → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'compose', var: 'x' }, w)).toBeNull();
        expect(w[0]).toContain('template');
    });
    it('slash-cmd: missing command → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'slash-cmd' }, w)).toBeNull();
        expect(w[0]).toContain('command');
    });
    it('image: missing prompt → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'image' }, w)).toBeNull();
        expect(w[0]).toContain('prompt');
    });
    it('load-image: missing path → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'load-image' }, w, 'R1')).toBeNull();
        expect(w[0]).toContain('path');
    });
    it('set-var: missing var → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'set-var', value: 'x' }, w)).toBeNull();
        expect(w[0]).toContain('"var"');
    });
    it('set-var: missing value → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'set-var', var: 'hp' }, w)).toBeNull();
        expect(w[0]).toContain('"value"');
    });
    it('set-var: invalid scope → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'set-var', var: 'hp', value: '10', scope: 'session' }, w)).toBeNull();
        expect(w[0]).toContain('"session"');
    });
    it('set-var: absent scope passes (defaults to chat)', () => {
        const w = [];
        expect(importAction({ type: 'set-var', var: 'hp', value: '10' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('update lorebook: missing lorebook → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'update', title: 'x' }, w)).toBeNull();
        expect(w[0]).toContain('lorebook');
    });
    it('update lorebook: missing title → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'update', lorebook: 'MyLB' }, w)).toBeNull();
        expect(w[0]).toContain('title');
    });
    it('update lorebook: both present passes', () => {
        const w = [];
        expect(importAction({ type: 'update', lorebook: 'MyLB', title: 'Entry' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('update text: missing value → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'update', target: 'text' }, w)).toBeNull();
        expect(w[0]).toContain('"value"');
    });
    it('update text: present value passes', () => {
        const w = [];
        expect(importAction({ type: 'update', target: 'text', value: 'hello' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('stop: no required fields', () => {
        const w = [];
        expect(importAction({ type: 'stop' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('switch-preset: missing preset → warn + null', () => {
        const w = [];
        expect(importAction({ type: 'switch-preset' }, w)).toBeNull();
        expect(w[0]).toContain('"preset"');
    });
    it('switch-preset: present preset passes', () => {
        const w = [];
        expect(importAction({ type: 'switch-preset', preset: 'Comfy 2' }, w)).not.toBeNull();
        expect(w).toHaveLength(0);
    });
    it('replace (legacy format key): imports as update(text, replaceKeyword)', () => {
        const w = [];
        const a = importAction({ type: 'replace', replacement: 'beast' }, w);
        expect(a).not.toBeNull();
        expect(a?.type).toBe('update');
        expect(a?.config.target).toBe('text');
        expect(a?.config.mode).toBe('replaceKeyword');
        expect(a?.config.value).toBe('beast');
        expect(w).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// importRule / importRuleset
// ---------------------------------------------------------------------------

describe('importRule', () => {
    it('wraps triggers and actions, assigns defaults', () => {
        const w   = [];
        const raw = { name: 'R', triggers: [{ type: 'keyword', keywords: 'x' }], actions: [{ type: 'stop' }] };
        const r   = importRule(raw, id, w);
        expect(r?.name).toBe('R');
        expect(r?.when).toBe('any');
        expect(r?.enabled).toBe(true);
        expect(r?.triggers[0].type).toBe('keyword');
        expect(r?.actions[0].type).toBe('stop');
        expect(w).toHaveLength(0);
    });
    it('generates id if missing', () => {
        const r = importRule({ triggers: [], actions: [] }, id, []);
        expect(r?.id).toBe('test-id');
    });
    it('preserves existing id and when', () => {
        const r = importRule({ id: 'abc', when: 'all', triggers: [], actions: [] }, id, []);
        expect(r?.id).toBe('abc');
        expect(r?.when).toBe('all');
    });
    it('skips broken triggers but keeps rule', () => {
        const w   = [];
        const raw = { triggers: [{ type: 'BROKEN' }, { type: 'keyword', keywords: 'x' }], actions: [] };
        const r   = importRule(raw, id, w);
        expect(r?.triggers).toHaveLength(1);
        expect(w).toHaveLength(1);
    });
    it('preserves note field', () => {
        const r = importRule({ triggers: [], actions: [], note: 'fires on weather language' }, id, []);
        expect(r?.note).toBe('fires on weather language');
    });
    it('omits note when absent', () => {
        const r = importRule({ triggers: [], actions: [] }, id, []);
        expect(r).not.toHaveProperty('note');
    });
});

describe('importRuleset', () => {
    it('imports ruleset with rules', () => {
        const w  = [];
        const rs = importRuleset({
            name: 'G1', rules: [{ triggers: [{ type: 'keyword', keywords: 'x' }], actions: [] }],
        }, id, w);
        expect(rs?.name).toBe('G1');
        expect(rs?.rules).toHaveLength(1);
        expect(rs?.enabled).toBe(true);
    });
    it('preserves note field', () => {
        const rs = importRuleset({ name: 'G', rules: [], note: 'weather detection group' }, id, []);
        expect(rs?.note).toBe('weather detection group');
    });
    it('omits note when absent', () => {
        const rs = importRuleset({ name: 'G', rules: [] }, id, []);
        expect(rs).not.toHaveProperty('note');
    });
});

// ---------------------------------------------------------------------------
// parseAndImport — shapes and JSONC
// ---------------------------------------------------------------------------

describe('parseAndImport', () => {
    it('imports a profile shape', () => {
        const json = JSON.stringify({ rulesets: [{ name: 'G', rules: [] }] });
        const { shape, rulesets, warnings } = parseAndImport(json, id);
        expect(shape).toBe('profile');
        expect(rulesets).toHaveLength(1);
        expect(warnings).toHaveLength(0);
    });
    it('imports a ruleset shape', () => {
        const json = JSON.stringify({ name: 'G', rules: [] });
        const { shape, rulesets } = parseAndImport(json, id);
        expect(shape).toBe('ruleset');
        expect(rulesets).toHaveLength(1);
    });
    it('imports a rule shape', () => {
        const json = JSON.stringify({ name: 'R', triggers: [{ type: 'keyword', keywords: 'x' }], actions: [{ type: 'stop' }] });
        const { shape, rule } = parseAndImport(json, id);
        expect(shape).toBe('rule');
        expect(rule?.triggers[0].type).toBe('keyword');
    });
    it('imports a bare array as a nameless ruleset', () => {
        const json = JSON.stringify([{ triggers: [], actions: [] }]);
        const { shape } = parseAndImport(json, id);
        expect(shape).toBe('ruleset');
    });
    it('strips JSONC comments before parse', () => {
        const text = '// header\n{ "rulesets": [ /* comment */ ] }';
        const { shape, warnings } = parseAndImport(text, id);
        expect(shape).toBe('profile');
        expect(warnings).toHaveLength(0);
    });
    it('returns shape:null on bad JSON', () => {
        const { shape, warnings } = parseAndImport('not json', id);
        expect(shape).toBeNull();
        expect(warnings[0]).toContain('Could not parse JSON');
    });
    it('collects warnings for unknown trigger/action types', () => {
        const json = JSON.stringify({
            triggers: [{ type: 'bad-trigger' }],
            actions:  [{ type: 'bad-action'  }],
        });
        const { shape, rule, warnings } = parseAndImport(json, id);
        expect(shape).toBe('rule');
        expect(rule?.triggers).toHaveLength(0);
        expect(rule?.actions).toHaveLength(0);
        expect(warnings).toHaveLength(2);
    });
    it('handles legacy rule-v1 shape', () => {
        const json = JSON.stringify({ type: 'rule', rule: { id: 'r1', triggers: [], actions: [], when: 'any' } });
        const { shape, rule } = parseAndImport(json, id);
        expect(shape).toBe('rule');
        expect(rule?.id).toBe('r1');
    });
});

// ---------------------------------------------------------------------------
// exportTrigger / exportAction
// ---------------------------------------------------------------------------

describe('exportTrigger', () => {
    it('exports keyword (text mode) with flat fields, no mode field', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', keywords: 'dragon', caseSensitive: false } });
        expect(out).toEqual({ type: 'keyword', keywords: 'dragon' });
    });
    it('includes case-sensitive when true', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', keywords: 'x', caseSensitive: true } });
        expect(out?.['case-sensitive']).toBe(true);
    });
    it('exports keyword (lorebook mode) with mode field', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'lorebook' } });
        expect(out).toEqual({ type: 'keyword', mode: 'lorebook' });
    });
    it('exports keyword (regex mode) with match-mode and pattern fields', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', matchMode: 'regex', pattern: '/dragon/i' } });
        expect(out).toEqual({ type: 'keyword', 'match-mode': 'regex', pattern: '/dragon/i' });
    });
    it('exports keyword legacy useRegex as match-mode:regex', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', useRegex: true, pattern: '/dragon/i' } });
        expect(out).toEqual({ type: 'keyword', 'match-mode': 'regex', pattern: '/dragon/i' });
    });
    it('exports keyword (fuzzy mode) with match-mode, keywords, and fuzzy-threshold', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', matchMode: 'fuzzy', keywords: 'Tavern', fuzzyThreshold: '75' } });
        expect(out?.['match-mode']).toBe('fuzzy');
        expect(out?.keywords).toBe('Tavern');
        expect(out?.['fuzzy-threshold']).toBe(75);
    });
    it('omits fuzzy-threshold from keyword export when default 80', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', matchMode: 'fuzzy', keywords: 'Tavern', fuzzyThreshold: '80' } });
        expect(out?.['fuzzy-threshold']).toBeUndefined();
    });
    it('translates chance back to probability', () => {
        const out = exportTrigger({ type: 'chance', config: { chance: 75 } });
        expect(out?.type).toBe('probability');
        expect(out?.chance).toBe(75);
    });
    it('translates varMatch with operator rename', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'mood', operator: 'notEmpty', value: '' } });
        expect(out?.type).toBe('var-match');
        expect(out?.var).toBe('mood');
        expect(out?.operator).toBe('not-empty');
        expect(out?.value).toBeUndefined();
    });
    it('exports notEquals as not-equals and includes value', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'hp', operator: 'notEquals', value: '0' } });
        expect(out?.operator).toBe('not-equals');
        expect(out?.value).toBe('0');
    });
    it('exports notSet as not-set and omits value', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'flag', operator: 'notSet', value: '' } });
        expect(out?.operator).toBe('not-set');
        expect(out?.value).toBeUndefined();
    });
    it('exports set operator and omits value', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'flag', operator: 'set', value: '' } });
        expect(out?.operator).toBe('set');
        expect(out?.value).toBeUndefined();
    });
    it('exports empty operator and omits value', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'summary', operator: 'empty', value: '' } });
        expect(out?.operator).toBe('empty');
        expect(out?.value).toBeUndefined();
    });
    it('exports varMatch with use-regex flag', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'hp', operator: 'equals', value: '^\\d+$', useRegex: true } });
        expect(out?.['use-regex']).toBe(true);
        expect(out?.value).toBe('^\\d+$');
    });
    it('exports varMatch fuzzy operator with value; omits fuzzy-threshold at default 80', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'loc', operator: 'fuzzy', value: 'Tavern', fuzzyThreshold: '80' } });
        expect(out?.operator).toBe('fuzzy');
        expect(out?.value).toBe('Tavern');
        expect(out?.['fuzzy-threshold']).toBeUndefined();
    });
    it('exports varMatch fuzzy operator with non-default fuzzy-threshold', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'loc', operator: 'fuzzy', value: 'Tavern', fuzzyThreshold: '75' } });
        expect(out?.['fuzzy-threshold']).toBe(75);
    });
    it('omits use-regex on operators with no value field', () => {
        const out = exportTrigger({ type: 'varMatch', config: { varName: 'f', operator: 'notEmpty', value: '', useRegex: true } });
        expect(out?.['use-regex']).toBeUndefined();
        expect(out?.value).toBeUndefined();
    });
    it('translates badge with split-on and click', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'top', label: 'Go', color: '#f00', splitOn: ',', clickAction: 'inject' } });
        expect(out?.['split-on']).toBe(',');
        expect(out?.click).toBe('inject');
    });
    it('omits click when default fire', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'top', label: 'Go', color: '#f00', splitOn: '', clickAction: 'fire' } });
        expect(out?.click).toBeUndefined();
    });
    it('exports inline badge (regex mode) with match-mode and pattern, no keywords field', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'inline', matchMode: 'regex', pattern: '/dragon/i', color: '#f00', clickAction: 'fire' } });
        expect(out?.['match-mode']).toBe('regex');
        expect(out?.pattern).toBe('/dragon/i');
        expect(out?.keywords).toBeUndefined();
    });
    it('exports inline badge legacy useRegex as match-mode:regex', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'inline', useRegex: true, pattern: '/dragon/i', color: '#f00', clickAction: 'fire' } });
        expect(out?.['match-mode']).toBe('regex');
        expect(out?.pattern).toBe('/dragon/i');
        expect(out?.keywords).toBeUndefined();
    });
    it('exports inline badge (fuzzy mode) with match-mode and keywords', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'inline', matchMode: 'fuzzy', keywords: 'Tavern', fuzzyThreshold: '80', color: '#f00', clickAction: 'fire' } });
        expect(out?.['match-mode']).toBe('fuzzy');
        expect(out?.keywords).toBe('Tavern');
        expect(out?.['fuzzy-threshold']).toBeUndefined();
    });
    it('preserves note', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'text', keywords: 'x', caseSensitive: false }, note: 'why' });
        expect(out?.note).toBe('why');
    });
    it('returns null for unknown internal type', () => {
        expect(exportTrigger({ type: 'unknownType', config: {} })).toBeNull();
    });
});

describe('exportAction', () => {
    it('translates sideCall back to call-llm with all field renames', () => {
        const out = exportAction({ type: 'sideCall', config: {
            prompt: 'hi {{history:[2]}}', outputMode: 'appendToMessage', callMode: 'perMatch',
            outputVar: 'res', profileId: 'p1',
        }});
        expect(out?.type).toBe('call-llm');
        expect(out).toMatchObject({ prompt: 'hi {{history:[2]}}', output: 'append', calls: 'per-match', var: 'res', connection: 'p1' });
        expect(out?.history).toBeUndefined();
    });
    it('omits call-llm defaults (output, calls, var, connection)', () => {
        const out = exportAction({ type: 'sideCall', config: { prompt: 'x', outputMode: 'replaceKeyword', callMode: 'once', outputVar: '', profileId: null } });
        expect(out?.output).toBeUndefined();
        expect(out?.calls).toBeUndefined();
        expect(out?.history).toBeUndefined();
        expect(out?.var).toBeUndefined();
        expect(out?.connection).toBeUndefined();
    });
    it('exports image (generate) with comfy-url', () => {
        const out = exportAction({ type: 'image', config: { source: 'comfy', model: '', comfyUiUrl: 'http://local', prompt: 'cat', outputVar: '', persist: true, path: '' } });
        expect(out?.type).toBe('image');
        expect(out?.['comfy-url']).toBe('http://local');
    });
    it('exports image (path) with source:path', () => {
        const out = exportAction({ type: 'image', config: { source: 'path', path: 'img/scene.png', outputVar: '', persist: true, model: '', comfyUiUrl: '', prompt: '' } });
        expect(out?.type).toBe('image');
        expect(out?.source).toBe('path');
        expect(out?.path).toBe('img/scene.png');
        expect(out?.prompt).toBeUndefined();
    });
    it('translates setStVar varName→var', () => {
        const out = exportAction({ type: 'setStVar', config: { scope: 'chat', varName: 'hp', key: '', value: '10' } });
        expect(out?.type).toBe('set-var');
        expect(out?.var).toBe('hp');
        expect(out?.scope).toBe('chat');
        expect(out?.key).toBeUndefined();   // omitted when empty
    });
    it('translates update text mode', () => {
        const out = exportAction({ type: 'update', config: { target: 'text', mode: 'replaceParagraph', value: 'x', outputVar: '', lorebook: '', title: '', keys: '', content: '' } });
        expect(out?.mode).toBe('replace-paragraph');
    });
    it('exports stop with andContinue:true as { type: stop, continue: true }', () => {
        const out = exportAction({ type: 'stop', config: { andContinue: true } });
        expect(out).toEqual({ type: 'stop', continue: true });
    });
    it('exports stop with andContinue:false as { type: stop } with no continue field', () => {
        const out = exportAction({ type: 'stop', config: { andContinue: false } });
        expect(out).toEqual({ type: 'stop' });
    });
    it('exports switchPreset with type switch-preset and preset field', () => {
        const out = exportAction({ type: 'switchPreset', config: { preset: 'Fight Scene', outputVar: '$prev' } });
        expect(out?.type).toBe('switch-preset');
        expect(out?.preset).toBe('Fight Scene');
        expect(out?.var).toBe('$prev');
    });
    it('omits var from switch-preset export when outputVar is empty', () => {
        const out = exportAction({ type: 'switchPreset', config: { preset: 'Comfy 2', outputVar: '' } });
        expect(out?.type).toBe('switch-preset');
        expect(out?.var).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Round-trip: import then export
// ---------------------------------------------------------------------------

describe('round-trip', () => {
    it('a rule survives import→export with correct field translations', () => {
        const json = JSON.stringify({
            name: 'Sentinel',
            when: 'any',
            triggers: [{ type: 'keyword', keywords: '[DONE]' }],
            actions:  [{ type: 'stop' }, { type: 'update', target: 'text', value: '' }],
        });
        const { rule } = parseAndImport(json, id);
        const exported = exportRule(rule);
        expect(exported.name).toBe('Sentinel');
        expect(exported.triggers[0]).toEqual({ type: 'keyword', keywords: '[DONE]' });
        expect(exported.actions[0]).toEqual({ type: 'stop' });
        expect(exported.actions[1]).toEqual({ type: 'update', target: 'text', value: '' });
    });

    it('legacy replace format key imports and round-trips as update', () => {
        const json = JSON.stringify({
            name: 'Sentinel',
            triggers: [{ type: 'keyword', keywords: '[DONE]' }],
            actions:  [{ type: 'replace', replacement: '' }],
        });
        const { rule } = parseAndImport(json, id);
        const exported = exportRule(rule);
        expect(exported.actions[0]).toEqual({ type: 'update', target: 'text', value: '' });
    });

    it('transform syntax in template string fields survives import→export unchanged', () => {
        const transforms = {
            replace:  '{{upper: {{keyword}}}}',
            compose:  '{{trim: {{upper: {{opts}}}}}}',
            prompt:   '{{lower: {{message}}}} and {{words: 20: {{paragraph}}}}',
            command:  '/send {{cap: {{keyword}}}}',
            value:    '{{default: none: {{myVar}}}}',
            template: '{{join: , : {{items}}}}',
        };
        const json = JSON.stringify({
            name: 'Transform round-trip',
            triggers: [{ type: 'keyword', keywords: 'test' }],
            actions: [
                { type: 'update',    target: 'text', value: transforms.replace },
                { type: 'compose',   var: 'out', template: transforms.compose },
                { type: 'call-llm',  prompt: transforms.prompt },
                { type: 'slash-cmd', command: transforms.command },
                { type: 'update',    target: 'text', value: transforms.value },
                { type: 'update',    lorebook: 'MyLB', title: 'Entry', content: transforms.template },
            ],
        });
        const { rule } = parseAndImport(json, id);
        const exported = exportRule(rule);
        expect(exported.actions[0].value).toBe(transforms.replace);
        expect(exported.actions[1].template).toBe(transforms.compose);
        expect(exported.actions[2].prompt).toBe(transforms.prompt);
        expect(exported.actions[3].command).toBe(transforms.command);
        expect(exported.actions[4].value).toBe(transforms.value);
        expect(exported.actions[5].content).toBe(transforms.template);
    });

    it('a ruleset survives import→export', () => {
        const json = JSON.stringify({
            name: 'G1',
            rules: [
                { name: 'R1', triggers: [{ type: 'event', event: 'MESSAGE_RECEIVED' }], actions: [{ type: 'call-llm', prompt: 'go', var: 'out' }] },
            ],
        });
        const { rulesets } = parseAndImport(json, id);
        const exported = exportRuleset(rulesets[0]);
        expect(exported.name).toBe('G1');
        expect(exported.rules[0].actions[0].var).toBe('out');
        expect(exported.rules[0].actions[0].type).toBe('call-llm');
    });
});

// ---------------------------------------------------------------------------
// exportRule / exportRuleset — note field
// ---------------------------------------------------------------------------

describe('exportRule', () => {
    it('preserves note field', () => {
        const out = exportRule({ id: 'r1', name: 'R', note: 'intent here', triggers: [], actions: [] });
        expect(out?.note).toBe('intent here');
    });
    it('omits note when absent', () => {
        const out = exportRule({ id: 'r1', triggers: [], actions: [] });
        expect(out).not.toHaveProperty('note');
    });
    it('omits note when empty string', () => {
        const out = exportRule({ id: 'r1', note: '', triggers: [], actions: [] });
        expect(out).not.toHaveProperty('note');
    });
});

describe('exportRuleset', () => {
    it('preserves note field', () => {
        const out = exportRuleset({ id: 'rs1', name: 'G', note: 'group intent', rules: [] });
        expect(out?.note).toBe('group intent');
    });
    it('omits note when absent', () => {
        const out = exportRuleset({ id: 'rs1', name: 'G', rules: [] });
        expect(out).not.toHaveProperty('note');
    });
    it('omits note when empty string', () => {
        const out = exportRuleset({ id: 'rs1', note: '', rules: [] });
        expect(out).not.toHaveProperty('note');
    });
});

// ---------------------------------------------------------------------------
// exportProfile
// ---------------------------------------------------------------------------

describe('exportProfile', () => {
    it('produces version 2 with nested rulesets', () => {
        const rs = { id: 'r1', name: 'G', enabled: true, rules: [] };
        const out = exportProfile('Default', [rs]);
        expect(out.version).toBe(2);
        expect(out.type).toBe('profile');
        expect(out.name).toBe('Default');
        expect(out.rulesets).toHaveLength(1);
        // rulesets inside profile don't carry version/type (profile wraps them)
        expect(out.rulesets[0].version).toBeUndefined();
        expect(out.rulesets[0].type).toBeUndefined();
    });
});
