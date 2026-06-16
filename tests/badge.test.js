import { vi, describe, it, expect, beforeEach } from 'vitest';

// badge.js lives at the extension root and imports extensions.js 3 levels up.
vi.mock('../../../extensions.js', () => ({
    extension_settings: { triggeryze: { showBadges: true } },
}));

// badge.js imports lb-query.js and kw-preview.js from triggers/, which use 5-up paths.
vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

// condition.js (loaded via triggers.js) reaches variables 5 levels up.
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { buildResolvedPatterns } from '../badge.js';
import { setTurnVar, clearTurnVars } from '../triggers/turn-vars.js';
import { clearWiCache }               from '../triggers/lb-query.js';

beforeEach(() => {
    clearTurnVars();
    clearWiCache();
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildResolvedPatterns
// ---------------------------------------------------------------------------

describe('buildResolvedPatterns', () => {
    it('returns empty array for empty defs', async () => {
        expect(await buildResolvedPatterns([])).toEqual([]);
    });

    it('returns empty array for null defs', async () => {
        expect(await buildResolvedPatterns(null)).toEqual([]);
    });

    it('produces one pattern per comma-separated keyword', async () => {
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: 'dragon, sword', caseSensitive: false, color: '#ff0000', clickAction: 'fire' },
        ]);
        expect(patterns).toHaveLength(2);
    });

    it('resolves {{varName}} in keywords from turn variables (Principle 15)', async () => {
        setTurnVar('target', 'flame');
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: '{{target}}', caseSensitive: false, color: '#8888ff', clickAction: 'fire' },
        ]);
        expect(patterns).toHaveLength(1);
        expect(patterns[0].re.test('the flame rises')).toBe(true);
    });

    it('{{varName}} with an unset variable produces no patterns (resolves to empty string)', async () => {
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: '{{missing}}', caseSensitive: false, color: '#8888ff', clickAction: 'fire' },
        ]);
        expect(patterns).toHaveLength(0);
    });

    it('passes clickAction through to each pattern', async () => {
        for (const action of ['fire', 'inject', 'inject-send']) {
            const patterns = await buildResolvedPatterns([
                { ruleId: 'r1', keywords: 'word', caseSensitive: false, color: '#8888ff', clickAction: action },
            ]);
            expect(patterns[0].clickAction).toBe(action);
        }
    });

    it('passes ruleId through to each pattern', async () => {
        const patterns = await buildResolvedPatterns([
            { ruleId: 'my-rule', keywords: 'word', caseSensitive: false, color: '#8888ff', clickAction: 'fire' },
        ]);
        expect(patterns[0].ruleId).toBe('my-rule');
    });

    it('is case-insensitive by default', async () => {
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: 'Dragon', caseSensitive: false, color: '#8888ff', clickAction: 'fire' },
        ]);
        expect(patterns[0].re.flags).toContain('i');
        expect(patterns[0].re.test('the DRAGON soars')).toBe(true);
    });

    it('is case-sensitive when flag is set', async () => {
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: 'Dragon', caseSensitive: true, color: '#8888ff', clickAction: 'fire' },
        ]);
        expect(patterns[0].re.flags).not.toContain('i');
        expect(patterns[0].re.test('the DRAGON soars')).toBe(false);
        expect(patterns[0].re.test('the Dragon soars')).toBe(true);
    });

    it('handles multiple defs in one call, preserving ruleId per pattern', async () => {
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: 'dragon', caseSensitive: false, color: '#f00', clickAction: 'fire' },
            { ruleId: 'r2', keywords: 'sword',  caseSensitive: false, color: '#0f0', clickAction: 'inject' },
        ]);
        expect(patterns).toHaveLength(2);
        expect(patterns[0].ruleId).toBe('r1');
        expect(patterns[1].ruleId).toBe('r2');
    });

    it('{{varName}} in keywords is expanded before keyword split', async () => {
        setTurnVar('items', 'fire, ice');
        const patterns = await buildResolvedPatterns([
            { ruleId: 'r1', keywords: '{{items}}', caseSensitive: false, color: '#8888ff', clickAction: 'fire' },
        ]);
        // 'fire, ice' split on comma → 2 patterns
        expect(patterns).toHaveLength(2);
        expect(patterns[0].re.test('fire bolt')).toBe(true);
        expect(patterns[1].re.test('ice shard')).toBe(true);
    });
});
