/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/switch-preset.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Registry — switchPreset action (Chat Completion preset selection)
 * @description
 * Switches the active Chat Completion preset by name using ST's PresetManager.
 * Supports {{variable}} interpolation on the preset name, enabling rules that
 * switch to a preset resolved earlier in the turn (e.g. a saved "previous" preset).
 * Optionally saves the currently active preset name to a turn variable before
 * switching so a later rule can revert.
 *
 * @api-declaration
 * switchPreset — action definition object for the ACTION_REGISTRY; preview(config, text) resolves
 *   the preset name and reports whether it exists without actually switching
 *
 * @contract
 *   assertions:
 *     purity:          none — calls getPresetManager().selectPreset, writes to vars
 *     state_ownership: none
 *     external_io:     getPresetManager (scripts/preset-manager.js)
 */

import { getPresetManager }    from '../../../../../scripts/preset-manager.js';
import { interpolate }         from './template.js';
import { esc }                 from './text.js';
import { renderVarLegend }     from './var-legend.js';
import { trgWarn, trgDev }    from '../logger.js';
import { testDrawerHtml, attachTestDrawer } from '../triggers/test-drawer.js';
import { getTurnVarsSnapshot } from '../triggers/turn-vars.js';

let _uid = 0;

// Resolves the preset name — shared by execute() and preview().
function resolveName(config, vars) {
    return interpolate((config.preset ?? '').trim(), {}, vars ?? {}).trim();
}

export const switchPreset = {
    label: 'switch preset',
    templateFields: cfg => [cfg.preset],
    defaultConfig: { preset: '', outputVar: '' },

    async execute(config, { vars, debug }) {
        const pm = getPresetManager();
        if (!pm) {
            trgWarn('switch-preset: PresetManager unavailable — Chat Completion backend required');
            return;
        }

        const name = resolveName(config, vars);
        if (!name) {
            trgWarn('switch-preset: preset name is empty');
            return;
        }

        if (config.outputVar && vars) {
            vars[config.outputVar] = pm.getSelectedPresetName() ?? '';
        }

        const value = pm.findPreset(name);
        if (value == null) {
            trgWarn(`switch-preset: preset "${name}" not found`);
            return;
        }

        pm.selectPreset(value);
        trgDev(debug, `  switch-preset: → "${name}"`);
    },

    async preview(config) {
        const name = resolveName(config, getTurnVarsSnapshot());
        if (!name) return { hint: 'Preset name is empty.' };
        const pm = getPresetManager();
        if (pm && pm.findPreset(name) == null) return { error: `Preset "${name}" not found.` };
        const note = config.outputVar ? ` (saving current preset name to {{${config.outputVar}}})` : '';
        return { output: `Would switch to preset "${name}"${note}` };
    },

    renderConfig($el, config, onChange, ctx) {
        const pm      = getPresetManager();
        const presets = pm ? pm.getAllPresets() : [];
        const dlId    = `trg-sp-dl-${++_uid}`;

        $el.html(`
<div class="trg-sc-wrap">
    <datalist id="${dlId}">
        ${presets.map(n => `<option value="${esc(n)}"></option>`).join('')}
    </datalist>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">preset</label>
        <input type="text" list="${dlId}" class="trg-cfg trg-sp-preset text_pole"
            placeholder="Preset name or {{variable}}"
            value="${esc(config.preset ?? '')}" style="flex:1" />
    </div>
    <div class="trg-sc-row" style="margin-top:4px">
        <label class="trg-sc-lbl">save prev as</label>
        <input type="text" class="trg-cfg trg-sp-outvar trg-outvar-field"
            placeholder="variable (optional)"
            value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <small class="trg-hint">Saves the currently active preset name into a variable before switching — use <code>{{variable}}</code> in a later rule to revert.</small>
    ${testDrawerHtml()}
</div>`);

        const read = () => ({
            preset:    $el.find('.trg-sp-preset').val().trim(),
            outputVar: $el.find('.trg-sp-outvar').val().trim(),
        });
        const refreshTestDrawer = attachTestDrawer($el, read, (cfg, text) => switchPreset.preview(cfg, text));
        $el.find('.trg-sp-preset, .trg-sp-outvar').on('input change', () => { onChange(read()); refreshTestDrawer(); });
    },
};
