import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../actions/template.js', () => ({
    interpolate: vi.fn((tpl, _sys, vars) => tpl.replace(/\{\{(\$?\w+)\}\}/g, (_, k) => vars?.[k] ?? '')),
}));

vi.mock('../actions/text.js',   () => ({ esc: vi.fn(s => String(s ?? '')) }));
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));
vi.mock('../logger.js',         () => ({ trgDev: vi.fn(), trgWarn: vi.fn() }));

// ---------------------------------------------------------------------------
// PresetManager mock factory
// ---------------------------------------------------------------------------

function makePm(presetMap = {}) {
    // presetMap: { name: optionValue }
    let selectedName = Object.keys(presetMap)[0] ?? '';
    return {
        getAllPresets:          vi.fn(() => Object.keys(presetMap)),
        findPreset:            vi.fn(name => presetMap[name] ?? undefined),
        selectPreset:          vi.fn(value => {
            const name = Object.entries(presetMap).find(([, v]) => v === value)?.[0];
            if (name != null) selectedName = name;
        }),
        getSelectedPresetName: vi.fn(() => selectedName),
    };
}

const pmRef = vi.hoisted(() => ({ current: null }));

vi.mock('../../../../../scripts/preset-manager.js', () => ({
    get getPresetManager() {
        return () => pmRef.current;
    },
}));

import { switchPreset } from '../actions/switch-preset.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
    return { vars: {}, debug: false, ...overrides };
}

beforeEach(() => {
    vi.clearAllMocks();
    pmRef.current = makePm({ 'Comfy 2': 'comfy2', 'Fight Scene': 'fight', 'Calm': 'calm' });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('switchPreset — metadata', () => {
    it('stage is postMessage', () => {
        expect(switchPreset.stage).toBe('postMessage');
    });

    it('defaultConfig shape is correct', () => {
        expect(switchPreset.defaultConfig).toEqual({ preset: '', outputVar: '' });
    });

    it('templateFields includes the preset name field', () => {
        const fields = switchPreset.templateFields({ preset: 'Fight Scene', outputVar: '' });
        expect(fields).toContain('Fight Scene');
    });
});

// ---------------------------------------------------------------------------
// execute — basic switching
// ---------------------------------------------------------------------------

describe('switchPreset execute — switching', () => {
    it('selects the preset by name', async () => {
        await switchPreset.execute({ preset: 'Fight Scene', outputVar: '' }, makeCtx());
        expect(pmRef.current.selectPreset).toHaveBeenCalledWith('fight');
    });

    it('resolves {{variables}} in the preset name', async () => {
        await switchPreset.execute({ preset: '{{target}}', outputVar: '' }, makeCtx({ vars: { target: 'Calm' } }));
        expect(pmRef.current.selectPreset).toHaveBeenCalledWith('calm');
    });

    it('does nothing when preset name is empty', async () => {
        await switchPreset.execute({ preset: '', outputVar: '' }, makeCtx());
        expect(pmRef.current.selectPreset).not.toHaveBeenCalled();
    });

    it('does nothing when preset name does not match any preset', async () => {
        const { trgWarn } = await import('../logger.js');
        await switchPreset.execute({ preset: 'No Such Preset', outputVar: '' }, makeCtx());
        expect(pmRef.current.selectPreset).not.toHaveBeenCalled();
        expect(trgWarn).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute — outputVar (save previous preset)
// ---------------------------------------------------------------------------

describe('switchPreset execute — outputVar', () => {
    it('saves the previous preset name into the named variable before switching', async () => {
        const vars = {};
        await switchPreset.execute({ preset: 'Fight Scene', outputVar: '$prev' }, makeCtx({ vars }));
        expect(vars['$prev']).toBe('Comfy 2');
        expect(pmRef.current.selectPreset).toHaveBeenCalledWith('fight');
    });

    it('does not write outputVar when none is configured', async () => {
        const vars = {};
        await switchPreset.execute({ preset: 'Fight Scene', outputVar: '' }, makeCtx({ vars }));
        expect(Object.keys(vars)).toHaveLength(0);
    });

    it('revert pattern: save prev then restore via variable', async () => {
        const vars = {};
        // First call: switch to fight, save previous
        await switchPreset.execute({ preset: 'Fight Scene', outputVar: '$prev' }, makeCtx({ vars }));
        expect(vars['$prev']).toBe('Comfy 2');

        // Second call: revert using saved name
        await switchPreset.execute({ preset: '{{$prev}}', outputVar: '' }, makeCtx({ vars }));
        expect(pmRef.current.selectPreset).toHaveBeenLastCalledWith('comfy2');
    });
});

// ---------------------------------------------------------------------------
// execute — null PresetManager (non-CC backend)
// ---------------------------------------------------------------------------

describe('switchPreset execute — no PresetManager', () => {
    it('does nothing when getPresetManager returns null', async () => {
        pmRef.current = null;
        const { trgWarn } = await import('../logger.js');
        await switchPreset.execute({ preset: 'Comfy 2', outputVar: '' }, makeCtx());
        expect(trgWarn).toHaveBeenCalled();
    });
});
