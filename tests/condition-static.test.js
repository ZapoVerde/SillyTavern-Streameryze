import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { findUnresolvedConditionText, extractConditionVarNames } from '../actions/condition.js';

describe('findUnresolvedConditionText', () => {
    it('returns null for a fully-resolvable literal comparison', () => {
        expect(findUnresolvedConditionText('mood = "happy"')).toBeNull();
    });

    it('returns null for a fully-resolvable AND of two comparisons', () => {
        expect(findUnresolvedConditionText('phase = "combat" AND mode = "hard"')).toBeNull();
    });

    it('returns null for a {{varName}}-wrapped variable-vs-variable comparison', () => {
        expect(findUnresolvedConditionText('chatvar::loc != {{loc}}')).toBeNull();
    });

    it('returns null for empty/not-empty/in/fuzzy forms', () => {
        expect(findUnresolvedConditionText('mood is empty')).toBeNull();
        expect(findUnresolvedConditionText('mood not-empty')).toBeNull();
        expect(findUnresolvedConditionText('mood in (a, b, c)')).toBeNull();
        expect(findUnresolvedConditionText('mood fuzzy "happy" 80')).toBeNull();
    });

    it('flags a bare unwrapped right-hand side on != as unresolved', () => {
        expect(findUnresolvedConditionText('chatvar::loc != loc')).toBe('chatvar::loc != loc');
    });

    it('flags a bare unwrapped right-hand side on =', () => {
        expect(findUnresolvedConditionText('a = b')).toBe('a = b');
    });

    it('returns null for an empty expression', () => {
        expect(findUnresolvedConditionText('')).toBeNull();
        expect(findUnresolvedConditionText(undefined)).toBeNull();
    });

    it('flags only the unresolved half of a mixed AND expression', () => {
        // "phase = \"combat\"" resolves to true/false; "a = b" never does — AND leaves a residue.
        const residue = findUnresolvedConditionText('phase = "combat" AND a = b');
        expect(residue).toContain('a = b');
    });
});

describe('extractConditionVarNames', () => {
    it('extracts a bare variable name', () => {
        expect(extractConditionVarNames('mood = "happy"')).toEqual(['mood']);
    });

    it('extracts a {{varName}}-wrapped reference on the right side', () => {
        expect(extractConditionVarNames('chatvar::loc != {{current}}')).toEqual(['current']);
    });

    it('excludes chatvar:: and globalvar:: prefixed names', () => {
        const names = extractConditionVarNames('chatvar::loc != {{current}} AND globalvar::mode = "on"');
        expect(names).toEqual(['current']);
    });

    it('excludes boolean and operator keywords', () => {
        expect(extractConditionVarNames('a = "x" AND b = "y"')).toEqual(['a', 'b']);
    });

    it('excludes numeric literals', () => {
        expect(extractConditionVarNames('hp < 20')).toEqual(['hp']);
    });

    it('returns an empty array for an empty expression', () => {
        expect(extractConditionVarNames('')).toEqual([]);
    });
});
