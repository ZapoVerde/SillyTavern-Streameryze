/**
 * @file triggers/varMatch.js
 * @stamp {"utc":"2026-06-23T00:00:00.000Z"}
 * @architectural-role Registry — variable match trigger entry
 * @description
 * Trigger that tests a named turn variable against a configurable operator and value.
 * Supports set/notSet existence checks and equals/notEquals/contains/notEmpty value checks.
 * When the regex tickbox is on, the value field is interpreted as a /pattern/flags string
 * (or plain text for a case-insensitive match), replacing the operator's normal string
 * comparison with a regex test. This adds notEquals+regex as a new combination.
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

import { getTurnVar, getTurnVarsSnapshot }    from './turn-vars.js';
import { parseRegexPattern, jaroWinkler }    from './kw-match.js';
import { trgWarn }                           from '../logger.js';

let _listSeq = 0;

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
    defaultConfig: { varName: '', operator: 'equals', value: '', useRegex: false, fuzzyThreshold: '80' },
    async test(_text, config, rulesetId) {
        const name = (config.varName ?? '').trim();
        if (!name) return null;
        const op       = config.operator ?? 'equals';
        const snapshot = getTurnVarsSnapshot(rulesetId);

        if (op === 'set')    return name in snapshot ? (String(snapshot[name] ?? '') || 'set') : null;
        if (op === 'notSet') return name in snapshot ? null : 'unset';

        if (!(name in snapshot)) {
            trgWarn(`varMatch: "${name}" not set this turn`);
            return null;
        }
        const actual = String(snapshot[name] ?? '');
        const target = config.value ?? '';

        if (config.useRegex) {
            const re = parseRegexPattern(target);
            if (!re) return null;
            const matched = re.test(actual);
            return op === 'notEquals' ? (!matched ? actual : null) : (matched ? actual : null);
        }

        if (op === 'fuzzy') {
            const rawNum  = parseFloat(config.fuzzyThreshold ?? '80');
            const thresh  = Number.isFinite(rawNum) ? rawNum / 100 : 0.80;
            return jaroWinkler(actual.toLowerCase(), target.toLowerCase()) >= thresh ? actual : null;
        }

        if (op === 'equals')    return actual === target ? actual : null;
        if (op === 'notEquals') return actual !== target ? actual : null;
        if (op === 'contains')  return actual.toLowerCase().includes(target.toLowerCase()) ? actual : null;
        if (op === 'notEmpty')  return actual.trim() !== '' ? actual : null;
        if (op === 'empty')     return actual.trim() === '' ? 'empty' : null;
        return null;
    },
    renderConfig($el, config, onChange, ctx) {
        const _noValue = ['notEmpty', 'empty', 'set', 'notSet'];
        const _hints = {
            equals:    'Fires when the variable value exactly matches the target (case-sensitive).',
            notEquals: 'Fires when the variable value does not match the target. Does not fire if the variable is unset.',
            contains:  'Fires when the variable value contains the target text (case-insensitive). Does not fire if the variable is unset.',
            fuzzy:     'Fires when the variable value fuzzy-matches the target (Jaro-Winkler). Threshold 0–100 (default 80). Does not fire if the variable is unset.',
            notEmpty:  'Fires when the variable is set and has a non-blank value.',
            empty:     'Fires when the variable is set but its value is blank or whitespace. Does not fire if the variable is unset.',
            set:       'Fires when the variable was written this turn, even if the value is empty.',
            notSet:    'Fires when the variable has not been written this turn.',
        };
        const op       = config.operator ?? 'equals';
        const useRegex = config.useRegex ?? false;
        const listId   = `trg-vm-vars-${++_listSeq}`;
        $el.html(`
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <input type="text" class="text_pole trg-cfg trg-vm-name" placeholder="variable name" value="${$('<span>').text(config.varName ?? '').html()}" list="${listId}" style="flex:1;min-width:80px" />
    <datalist id="${listId}"></datalist>
    <select class="trg-cfg trg-vm-op" style="flex:0 0 auto">
        <option value="equals"    ${op === 'equals'    ? 'selected' : ''}>equals</option>
        <option value="notEquals" ${op === 'notEquals' ? 'selected' : ''}>not equals</option>
        <option value="contains"  ${op === 'contains'  ? 'selected' : ''}>contains</option>
        <option value="fuzzy"     ${op === 'fuzzy'     ? 'selected' : ''}>fuzzy</option>
        <option value="notEmpty"  ${op === 'notEmpty'  ? 'selected' : ''}>not empty</option>
        <option value="empty"     ${op === 'empty'     ? 'selected' : ''}>is empty</option>
        <option value="set"       ${op === 'set'       ? 'selected' : ''}>is set</option>
        <option value="notSet"    ${op === 'notSet'    ? 'selected' : ''}>is not set</option>
    </select>
    <input type="text" class="text_pole trg-cfg trg-vm-value" placeholder="value"
        value="${$('<span>').text(config.value ?? '').html()}"
        style="flex:1;min-width:80px;${_noValue.includes(op) ? 'display:none' : ''}" />
    <input type="number" class="trg-vm-fuzz-thresh" min="0" max="100"
        value="${$('<span>').text(config.fuzzyThreshold ?? '80').html()}"
        title="Jaro-Winkler threshold 0–100"
        style="width:52px;flex:0 0 auto;${op !== 'fuzzy' ? 'visibility:hidden' : ''}" />
    <label class="trg-check-row trg-vm-regex-row" style="flex:0 0 auto${_noValue.includes(op) ? ';display:none' : ''}">
        <input type="checkbox" class="trg-cfg trg-vm-regex" ${useRegex ? 'checked' : ''} />
        regex
    </label>
</div>
<div class="trg-vm-op-hint" style="margin-top:3px;font-size:.82em;opacity:.7;">${_hints[op] ?? ''}</div>
<div class="trg-var-preview" style="display:none;margin-top:3px;font-size:.82em;opacity:.8;"></div>`);

        const $name   = $el.find('.trg-vm-name');
        const $op     = $el.find('.trg-vm-op');
        const $value  = $el.find('.trg-vm-value');
        const $regex  = $el.find('.trg-vm-regex-row');
        const $hint   = $el.find('.trg-vm-op-hint');
        const $list   = $el.find(`#${listId}`);

        const fillList = () => {
            $list.empty();
            for (const name of (ctx?.varNames ?? []))
                $list.append($('<option>').val(name));
        };
        fillList();
        $name.on('focus', fillList);

        updateVarPreview($el, config.varName ?? '');

        const $thresh = $el.find('.trg-vm-fuzz-thresh');

        const read = () => ({
            varName:        $name.val(),
            operator:       $op.val(),
            value:          $value.val(),
            useRegex:       $el.find('.trg-vm-regex').prop('checked'),
            fuzzyThreshold: $thresh.val(),
        });
        $name.on('input', function () {
            onChange(read());
            updateVarPreview($el, this.value.trim());
        });
        $op.on('change', function () {
            const hide = _noValue.includes(this.value);
            $value.toggle(!hide);
            $regex.toggle(!hide);
            $thresh.css('visibility', this.value === 'fuzzy' ? 'visible' : 'hidden');
            $hint.text(_hints[this.value] ?? '');
            onChange(read());
        });
        $value.on('input', () => onChange(read()));
        $thresh.on('input', () => onChange(read()));
        $el.find('.trg-vm-regex').on('change', () => onChange(read()));
    },
};
