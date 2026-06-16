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
        expect(t).toEqual({ type: 'keyword', config: { mode: 'text', keywords: 'dragon', caseSensitive: true } });
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
        expect(a?.type).toBe('imageGen');
        expect(a?.config.comfyUiUrl).toBe('http://local');
        expect(a?.config.prompt).toBe('{{history:[2]}} cat');
        expect(a?.config).not.toHaveProperty('historyTurns');
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
    it('exports keyword (regex mode) with mode and pattern fields', () => {
        const out = exportTrigger({ type: 'keyword', config: { mode: 'regex', pattern: '/dragon/i' } });
        expect(out).toEqual({ type: 'keyword', mode: 'regex', pattern: '/dragon/i' });
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
    it('translates badge with split-on and click', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'top', label: 'Go', color: '#f00', splitOn: ',', clickAction: 'inject' } });
        expect(out?.['split-on']).toBe(',');
        expect(out?.click).toBe('inject');
    });
    it('omits click when default fire', () => {
        const out = exportTrigger({ type: 'badge', config: { style: 'top', label: 'Go', color: '#f00', splitOn: '', clickAction: 'fire' } });
        expect(out?.click).toBeUndefined();
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
    it('translates imageGen comfyUiUrl→comfy-url', () => {
        const out = exportAction({ type: 'imageGen', config: { source: 'comfy', model: '', comfyUiUrl: 'http://local', prompt: 'cat', outputVar: '', persist: true } });
        expect(out?.type).toBe('image');
        expect(out?.['comfy-url']).toBe('http://local');
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
            actions:  [{ type: 'stop' }, { type: 'replace', replacement: '' }],
        });
        const { rule } = parseAndImport(json, id);
        const exported = exportRule(rule);
        expect(exported.name).toBe('Sentinel');
        expect(exported.triggers[0]).toEqual({ type: 'keyword', keywords: '[DONE]' });
        expect(exported.actions[0]).toEqual({ type: 'stop' });
        expect(exported.actions[1]).toEqual({ type: 'replace', replacement: '' });
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
