import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ name1: 'User', name2: 'Char' }));

vi.mock('../actions/template.js', () => ({
    interpolate:     vi.fn((tpl, _sys, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '')),
    resolveLbTokens: vi.fn(async (s) => s),
}));

vi.mock('../actions/text.js',       () => ({ esc: vi.fn(s => String(s ?? '')) }));
vi.mock('../logger.js',             () => ({ trgDev: vi.fn(), trgWarn: vi.fn() }));

// ---------------------------------------------------------------------------
// PromptManager mock factory
// ---------------------------------------------------------------------------

function makePm() {
    const prompts = [];
    const order   = [];
    return {
        serviceSettings: { prompts },
        activeCharacter: { name: 'TestChar' },
        getPromptById(id) { return prompts.find(p => p.identifier === id) ?? null; },
        addPrompt(obj, id) { prompts.push({ ...obj, identifier: id }); },
        getPromptOrderForCharacter(_char) { return order; },
        saveServiceSettings: vi.fn(),
        _order:   order,
        _prompts: prompts,
    };
}

// The module imports promptManager at module load time, so we hoist the mock.
const pmRef = vi.hoisted(() => ({ current: null }));

vi.mock('../../../../../scripts/openai.js', () => ({
    get promptManager() { return pmRef.current; },
    oai_settings: { prompts: [] },
}));

vi.stubGlobal('window', {});

import { preset, listTrgPresets, reportTrgPresets, ensureTrgPreset } from '../actions/preset.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
    return {
        matchedKeyword: 'dragon',
        messageId:      0,
        stCtx:          { chat: [{ mes: 'A dragon appeared.' }] },
        vars:           {},
        debug:          false,
        highlighted:    '',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    pmRef.current = makePm();
    window.toastr   = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    window.confirm  = vi.fn(() => true);
});

// ---------------------------------------------------------------------------
// ensureTrgPreset
// ---------------------------------------------------------------------------

describe('ensureTrgPreset', () => {
    it('creates the prompt and returns true on first call', () => {
        const pm = pmRef.current;
        const created = ensureTrgPreset(pm, 'trg_preset_weather', 'Weather');
        expect(created).toBe(true);
        expect(pm.getPromptById('trg_preset_weather')).not.toBeNull();
        expect(pm.saveServiceSettings).toHaveBeenCalledTimes(1);
    });

    it('inserts before chatHistory in the prompt order', () => {
        const pm = pmRef.current;
        pm._order.push({ identifier: 'chatHistory', enabled: true });
        ensureTrgPreset(pm, 'trg_preset_weather', 'Weather');
        expect(pm._order[0].identifier).toBe('trg_preset_weather');
        expect(pm._order[1].identifier).toBe('chatHistory');
    });

    it('appends to order when chatHistory is absent', () => {
        const pm = pmRef.current;
        ensureTrgPreset(pm, 'trg_preset_weather', 'Weather');
        expect(pm._order[0].identifier).toBe('trg_preset_weather');
    });

    it('returns false and does not save if the prompt already exists', () => {
        const pm = pmRef.current;
        ensureTrgPreset(pm, 'trg_preset_weather', 'Weather');
        pm.saveServiceSettings.mockClear();
        const created = ensureTrgPreset(pm, 'trg_preset_weather', 'Weather');
        expect(created).toBe(false);
        expect(pm.saveServiceSettings).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// listTrgPresets
// ---------------------------------------------------------------------------

describe('listTrgPresets', () => {
    it('returns names of TRG-owned prompts', () => {
        const pm = pmRef.current;
        pm._prompts.push(
            { identifier: 'trg_preset_weather', name: 'Weather' },
            { identifier: 'trg_preset_mood',    name: 'Mood'    },
        );
        expect(listTrgPresets(pm)).toEqual(['Weather', 'Mood']);
    });

    it('excludes non-TRG prompts', () => {
        const pm = pmRef.current;
        pm._prompts.push(
            { identifier: 'cnz_summary',        name: 'CNZ Summary' },
            { identifier: 'trg_preset_weather', name: 'Weather'     },
        );
        expect(listTrgPresets(pm)).toEqual(['Weather']);
    });

    it('returns empty array when pm is null', () => {
        expect(listTrgPresets(null)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// reportTrgPresets
// ---------------------------------------------------------------------------

describe('reportTrgPresets', () => {
    it('fires toastr.info listing preset names when presets exist', () => {
        const pm = pmRef.current;
        pm._prompts.push({ identifier: 'trg_preset_weather', name: 'Weather' });
        reportTrgPresets();
        expect(window.toastr.info).toHaveBeenCalledOnce();
        const [msg, title] = window.toastr.info.mock.calls[0];
        expect(msg).toContain('Weather');
        expect(title).toBe('TRG presets active');
    });

    it('does not fire when no TRG presets exist', () => {
        reportTrgPresets();
        expect(window.toastr.info).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute — write mode
// ---------------------------------------------------------------------------

describe('preset execute — write', () => {
    it('creates the prompt and fires toastr on first write', async () => {
        await preset.execute({ name: 'Weather', content: 'It is raining.', mode: 'write' }, makeCtx());
        expect(pmRef.current.getPromptById('trg_preset_weather')).not.toBeNull();
        expect(window.toastr.info).toHaveBeenCalledOnce();
        expect(window.toastr.info.mock.calls[0][0]).toContain('Weather');
    });

    it('does not fire toastr on subsequent writes to the same preset', async () => {
        await preset.execute({ name: 'Weather', content: 'Sunny.', mode: 'write' }, makeCtx());
        window.toastr.info.mockClear();
        await preset.execute({ name: 'Weather', content: 'Cloudy.', mode: 'write' }, makeCtx());
        expect(window.toastr.info).not.toHaveBeenCalled();
    });

    it('sets the prompt content', async () => {
        await preset.execute({ name: 'Weather', content: 'It is raining.', mode: 'write' }, makeCtx());
        const p = pmRef.current.getPromptById('trg_preset_weather');
        expect(p.content).toBe('It is raining.');
    });

    it('slugifies the name for the id — spaces and caps', async () => {
        await preset.execute({ name: 'My Weather State', content: 'x', mode: 'write' }, makeCtx());
        expect(pmRef.current.getPromptById('trg_preset_my-weather-state')).not.toBeNull();
    });

    it('resolves {{variables}} in content', async () => {
        const { interpolate } = await import('../actions/template.js');
        await preset.execute({ name: 'Mood', content: '{{emotion}}', mode: 'write' }, makeCtx({ vars: { emotion: 'happy' } }));
        expect(interpolate).toHaveBeenCalled();
    });

    it('resolves {{variables}} in the name field', async () => {
        await preset.execute({ name: '{{presetName}}', content: 'x', mode: 'write' }, makeCtx({ vars: { presetName: 'Weather' } }));
        expect(pmRef.current.getPromptById('trg_preset_weather')).not.toBeNull();
    });

    it('resolves {{variables}} in name and derives id from resolved value', async () => {
        await preset.execute({ name: '{{presetName}}', content: 'storm', mode: 'write' }, makeCtx({ vars: { presetName: 'Climate State' } }));
        expect(pmRef.current.getPromptById('trg_preset_climate-state')).not.toBeNull();
    });

    it('is a no-op when name is blank', async () => {
        await preset.execute({ name: '', content: 'x', mode: 'write' }, makeCtx());
        expect(pmRef.current._prompts).toHaveLength(0);
        expect(window.toastr.info).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute — clear mode
// ---------------------------------------------------------------------------

describe('preset execute — clear', () => {
    it('blanks the content without removing the prompt', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        await preset.execute({ name: 'Weather', content: '', mode: 'clear' }, makeCtx());
        const p = pmRef.current.getPromptById('trg_preset_weather');
        expect(p).not.toBeNull();
        expect(p.content).toBe('');
    });

    it('does not fire toastr', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        window.toastr.info.mockClear();
        await preset.execute({ name: 'Weather', content: '', mode: 'clear' }, makeCtx());
        expect(window.toastr.info).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute — remove mode
// ---------------------------------------------------------------------------

describe('preset execute — remove', () => {
    it('removes the prompt from the prompts list and the order', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        expect(pmRef.current._prompts).toHaveLength(1);
        await preset.execute({ name: 'Weather', content: '', mode: 'remove' }, makeCtx());
        expect(pmRef.current._prompts).toHaveLength(0);
        expect(pmRef.current._order).toHaveLength(0);
    });

    it('saves after removal', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        pmRef.current.saveServiceSettings.mockClear();
        await preset.execute({ name: 'Weather', content: '', mode: 'remove' }, makeCtx());
        expect(pmRef.current.saveServiceSettings).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// execute — null promptManager (non-CC backend)
// ---------------------------------------------------------------------------

describe('preset execute — no promptManager', () => {
    it('does nothing when promptManager is null', async () => {
        pmRef.current = null;
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write' }, makeCtx());
        expect(window.toastr.info).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// confirm gates
// ---------------------------------------------------------------------------

describe('preset execute — confirmCreate', () => {
    it('shows confirm before creating when confirmCreate is set', async () => {
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write', confirmCreate: true }, makeCtx());
        expect(window.confirm).toHaveBeenCalledOnce();
        expect(window.confirm.mock.calls[0][0]).toContain('Weather');
    });

    it('aborts creation when user cancels', async () => {
        window.confirm.mockReturnValue(false);
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write', confirmCreate: true }, makeCtx());
        expect(pmRef.current._prompts).toHaveLength(0);
        expect(window.toastr.info).not.toHaveBeenCalled();
    });

    it('proceeds with creation when user confirms', async () => {
        window.confirm.mockReturnValue(true);
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write', confirmCreate: true }, makeCtx());
        expect(pmRef.current._prompts).toHaveLength(1);
    });

    it('does not show confirm on create when confirmCreate is false', async () => {
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write', confirmCreate: false }, makeCtx());
        expect(window.confirm).not.toHaveBeenCalled();
    });
});

describe('preset execute — confirmUpdate', () => {
    it('shows confirm before updating an existing preset', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        window.confirm.mockClear();
        await preset.execute({ name: 'Weather', content: 'Sunny.', mode: 'write', confirmUpdate: true }, makeCtx());
        expect(window.confirm).toHaveBeenCalledOnce();
        expect(window.confirm.mock.calls[0][0]).toContain('Weather');
    });

    it('aborts update when user cancels — content unchanged', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        window.confirm.mockReturnValue(false);
        await preset.execute({ name: 'Weather', content: 'Sunny.', mode: 'write', confirmUpdate: true }, makeCtx());
        expect(pmRef.current.getPromptById('trg_preset_weather').content).toBe('Rainy.');
    });

    it('does not show confirm for create when only confirmUpdate is set', async () => {
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write', confirmUpdate: true }, makeCtx());
        expect(window.confirm).not.toHaveBeenCalled();
    });

    it('shows confirm before clearing when confirmUpdate is set', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        await preset.execute({ name: 'Weather', content: '', mode: 'clear', confirmUpdate: true }, makeCtx());
        expect(window.confirm).toHaveBeenCalledOnce();
    });

    it('aborts clear when user cancels', async () => {
        await preset.execute({ name: 'Weather', content: 'Rainy.', mode: 'write' }, makeCtx());
        pmRef.current.getPromptById('trg_preset_weather').content = 'Rainy.';
        window.confirm.mockReturnValue(false);
        await preset.execute({ name: 'Weather', content: '', mode: 'clear', confirmUpdate: true }, makeCtx());
        expect(pmRef.current.getPromptById('trg_preset_weather').content).toBe('Rainy.');
    });
});

describe('preset execute — confirmDestroy', () => {
    it('shows confirm before removing when confirmDestroy is set', async () => {
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write' }, makeCtx());
        await preset.execute({ name: 'Weather', content: '', mode: 'remove', confirmDestroy: true }, makeCtx());
        expect(window.confirm).toHaveBeenCalledOnce();
        expect(window.confirm.mock.calls[0][0]).toContain('Weather');
    });

    it('aborts removal when user cancels', async () => {
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write' }, makeCtx());
        window.confirm.mockReturnValue(false);
        await preset.execute({ name: 'Weather', content: '', mode: 'remove', confirmDestroy: true }, makeCtx());
        expect(pmRef.current._prompts).toHaveLength(1);
    });

    it('does not show confirm on remove when confirmDestroy is false', async () => {
        await preset.execute({ name: 'Weather', content: 'x', mode: 'write' }, makeCtx());
        await preset.execute({ name: 'Weather', content: '', mode: 'remove' }, makeCtx());
        expect(window.confirm).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('preset — metadata', () => {
    it('defaultConfig shape is correct', () => {
        expect(preset.defaultConfig).toMatchObject({ name: '', content: '', mode: 'write' });
    });

    it('templateFields includes both name and content', () => {
        const fields = preset.templateFields({ name: 'X', content: 'hello', mode: 'write' });
        expect(fields).toContain('hello');
        expect(fields).toContain('X');
    });
});

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

describe('preset — preview', () => {
    it('returns a hint when the resolved name is empty', async () => {
        const result = await preset.preview({ name: '', content: 'x', mode: 'write' }, 'some text');
        expect(result.hint).toBeTruthy();
    });

    it('reports create when the preset does not exist yet, without writing or toasting', async () => {
        const result = await preset.preview({ name: 'Scene Mood', content: 'tense', mode: 'write' }, 'text');
        expect(result.output).toBe('Would create preset "Scene Mood":\ntense');
        expect(pmRef.current.saveServiceSettings).not.toHaveBeenCalled();
        expect(window.toastr.info).not.toHaveBeenCalled();
        expect(pmRef.current._prompts).toHaveLength(0);
    });

    it('reports update when the preset already exists', async () => {
        await preset.execute({ name: 'Scene Mood', content: 'tense', mode: 'write' }, makeCtx());
        vi.clearAllMocks();

        const result = await preset.preview({ name: 'Scene Mood', content: 'calm now', mode: 'write' }, 'text');
        expect(result.output).toBe('Would update preset "Scene Mood":\ncalm now');
        expect(pmRef.current.saveServiceSettings).not.toHaveBeenCalled();
    });

    it('reports clear/remove without a confirm dialog or mutation', async () => {
        await preset.execute({ name: 'Scene Mood', content: 'tense', mode: 'write' }, makeCtx());
        vi.clearAllMocks();

        const clearResult = await preset.preview({ name: 'Scene Mood', mode: 'clear' }, 'text');
        expect(clearResult.output).toBe('Would clear preset "Scene Mood"');
        const removeResult = await preset.preview({ name: 'Scene Mood', mode: 'remove' }, 'text');
        expect(removeResult.output).toBe('Would remove preset "Scene Mood"');

        expect(window.confirm).not.toHaveBeenCalled();
        expect(pmRef.current.saveServiceSettings).not.toHaveBeenCalled();
        expect(pmRef.current._prompts).toHaveLength(1);
    });
});
