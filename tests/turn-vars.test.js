import { describe, it, expect, beforeEach } from 'vitest';
import { setTurnVar, getTurnVar, clearTurnVars, getTurnVarsSnapshot } from '../triggers/turn-vars.js';

beforeEach(() => clearTurnVars());

describe('turn-vars — ruleset scoping', () => {
    it('isolates vars between rulesets', () => {
        setTurnVar('count', '5', 'rs1');
        expect(getTurnVar('count', 'rs2')).toBeUndefined();
    });

    it('reads own scoped var', () => {
        setTurnVar('count', '5', 'rs1');
        expect(getTurnVar('count', 'rs1')).toBe('5');
    });

    it('two rulesets can hold different values for the same name', () => {
        setTurnVar('x', 'alpha', 'rs1');
        setTurnVar('x', 'beta',  'rs2');
        expect(getTurnVar('x', 'rs1')).toBe('alpha');
        expect(getTurnVar('x', 'rs2')).toBe('beta');
    });
});

describe('turn-vars — $ global prefix', () => {
    it('$ var is readable from any ruleset', () => {
        setTurnVar('$shared', 'hello', 'rs1');
        expect(getTurnVar('$shared', 'rs2')).toBe('hello');
        expect(getTurnVar('$shared', 'rs3')).toBe('hello');
    });

    it('$ var is readable without a rulesetId', () => {
        setTurnVar('$shared', 'hello', 'rs1');
        expect(getTurnVar('$shared')).toBe('hello');
    });

    it('$ write without rulesetId also goes to global', () => {
        setTurnVar('$g', 'val');
        expect(getTurnVar('$g', 'rs1')).toBe('val');
    });
});

describe('turn-vars — no rulesetId falls through to global', () => {
    it('write without rulesetId is readable by all rulesets', () => {
        setTurnVar('dom_event_name', 'click');
        expect(getTurnVar('dom_event_name', 'rs1')).toBe('click');
        expect(getTurnVar('dom_event_name', 'rs2')).toBe('click');
    });

    it('scoped var shadows global of same name in snapshot', () => {
        setTurnVar('x', 'global-val');
        setTurnVar('x', 'local-val', 'rs1');
        expect(getTurnVarsSnapshot('rs1').x).toBe('local-val');
        expect(getTurnVarsSnapshot('rs2').x).toBe('global-val');
    });
});

describe('turn-vars — getTurnVarsSnapshot', () => {
    it('includes both global and scoped vars for the given ruleset', () => {
        setTurnVar('dom_event_name', 'click');
        setTurnVar('result', 'ok', 'rs1');
        const snap = getTurnVarsSnapshot('rs1');
        expect(snap.dom_event_name).toBe('click');
        expect(snap.result).toBe('ok');
    });

    it('snapshot without rulesetId returns only global vars', () => {
        setTurnVar('local', 'only-rs1', 'rs1');
        setTurnVar('$g', 'global');
        const snap = getTurnVarsSnapshot();
        expect(snap['$g']).toBe('global');
        expect(snap.local).toBeUndefined();
    });

    it('snapshot for unknown rulesetId returns only globals', () => {
        setTurnVar('dom_event_name', 'click');
        const snap = getTurnVarsSnapshot('unknown');
        expect(snap.dom_event_name).toBe('click');
    });
});

describe('turn-vars — clearTurnVars', () => {
    it('wipes global vars', () => {
        setTurnVar('$g', 'val');
        clearTurnVars();
        expect(getTurnVar('$g')).toBeUndefined();
    });

    it('wipes scoped vars', () => {
        setTurnVar('x', 'val', 'rs1');
        clearTurnVars();
        expect(getTurnVar('x', 'rs1')).toBeUndefined();
    });
});
