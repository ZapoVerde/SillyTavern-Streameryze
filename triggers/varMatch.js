/**
 * @file triggers/varMatch.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — variable match trigger entry
 * @description
 * Trigger that tests a named turn variable against a configurable operator and value.
 * Supports set/notSet existence checks and equals/notEquals/contains/matches/notEmpty
 * value checks. Fires when the condition is satisfied.
 *
 * @api-declaration
 * varMatchTrigger — trigger registry entry object
 *
 * @contract
 *   assertions:
 *     purity:          test() is read-only; renderConfig mutates DOM only
 *     state_ownership: none
 *     external_io:     none (reads turn vars via getTurnVar / _turnVars directly)
 */

import { getTurnVar, getTurnVarsSnapshot } from './turn-vars.js';

// Renders the current value of a named var as a small preview hint under the input.
function updateVarPreview($el, varName) {
    const $p = $el.find('.trg-var-preview');
    if (!varName) { $p.hide().empty(); return; }
    const val = getTurnVar(varName);
    const snapshot = getTurnVarsSnapshot();
    if (!(varName in snapshot)) {
        $p.html(`<span class="trg-prev-unset">"${$('<span>').text(varName).html()}" not set this turn</span>`).show();
    } else {
        $p.html(`current: <span class="trg-prev-kw">${$('<span>').text(String(val ?? '')).html()}</span>`).show();
    }
}

export const varMatchTrigger = {
    label: 'variable match',
    defaultConfig: { varName: '', operator: 'equals', value: '' },
    async test(_text, config) {
        const name = (config.varName ?? '').trim();
        if (!name) return null;
        const op       = config.operator ?? 'equals';
        const snapshot = getTurnVarsSnapshot();

        if (op === 'set')    return name in snapshot ? (String(snapshot[name] ?? '') || 'set') : null;
        if (op === 'notSet') return name in snapshot ? null : 'unset';

        if (!(name in snapshot)) {
            console.warn(`[triggeryze] varMatch: "${name}" not set this turn`);
            return null;
        }
        const actual = String(snapshot[name] ?? '');
        const target = config.value ?? '';
        if (op === 'equals')    return actual === target ? actual : null;
        if (op === 'notEquals') return actual !== target ? actual : null;
        if (op === 'contains')  return actual.toLowerCase().includes(target.toLowerCase()) ? actual : null;
        if (op === 'matches')   { try { return new RegExp(target, 'i').test(actual) ? actual : null; } catch { return null; } }
        if (op === 'notEmpty')  return actual.trim() !== '' ? actual : null;
        return null;
    },
    renderConfig($el, config, onChange) {
        const _noValue = ['notEmpty', 'set', 'notSet'];
        const op = config.operator ?? 'equals';
        $el.html(`
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <input type="text" class="text_pole trg-cfg trg-vm-name" placeholder="variable name" value="${$('<span>').text(config.varName ?? '').html()}" style="flex:1;min-width:80px" />
    <select class="trg-cfg trg-vm-op" style="flex:0 0 auto">
        <option value="equals"    ${op === 'equals'    ? 'selected' : ''}>equals</option>
        <option value="notEquals" ${op === 'notEquals' ? 'selected' : ''}>not equals</option>
        <option value="contains"  ${op === 'contains'  ? 'selected' : ''}>contains</option>
        <option value="matches"   ${op === 'matches'   ? 'selected' : ''}>matches regex</option>
        <option value="notEmpty"  ${op === 'notEmpty'  ? 'selected' : ''}>not empty</option>
        <option value="set"       ${op === 'set'       ? 'selected' : ''}>is set</option>
        <option value="notSet"    ${op === 'notSet'    ? 'selected' : ''}>is not set</option>
    </select>
    <input type="text" class="text_pole trg-cfg trg-vm-value" placeholder="value"
        value="${$('<span>').text(config.value ?? '').html()}"
        style="flex:1;min-width:80px;${_noValue.includes(op) ? 'display:none' : ''}" />
</div>
<div class="trg-var-preview" style="display:none;margin-top:3px;font-size:.82em;opacity:.8;"></div>`);

        const $name  = $el.find('.trg-vm-name');
        const $op    = $el.find('.trg-vm-op');
        const $value = $el.find('.trg-vm-value');

        updateVarPreview($el, config.varName ?? '');

        const read = () => ({
            varName:  $name.val(),
            operator: $op.val(),
            value:    $value.val(),
        });
        $name.on('input', function () {
            onChange(read());
            updateVarPreview($el, this.value.trim());
        });
        $op.on('change', function () {
            $value.toggle(!_noValue.includes(this.value));
            onChange(read());
        });
        $value.on('input', () => onChange(read()));
    },
};
