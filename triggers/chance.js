/**
 * @file triggers/chance.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — probability trigger entry
 * @description
 * Trigger that fires with a configurable probability each generation. Combine with
 * other triggers (AND logic) to make any rule probabilistic.
 *
 * @api-declaration
 * chanceTrigger — trigger registry entry object
 *
 * @contract
 *   assertions:
 *     purity:          test() reads Math.random() only — no state mutations
 *     state_ownership: none
 *     external_io:     none
 */

export const chanceTrigger = {
    label: 'probability',
    defaultConfig: { chance: 50 },
    async test(_text, config) {
        const pct = Number(config.chance ?? 50);
        return Math.random() * 100 < pct ? 'chance' : null;
    },
    renderConfig($el, config, onChange) {
        const pct = Number(config.chance ?? 50);
        $el.html(`
<div style="display:flex;align-items:center;gap:8px">
    <input type="range" class="trg-ch-range" min="0" max="100" step="1" value="${pct}"
        style="flex:1;cursor:pointer" />
    <input type="number" class="trg-cfg trg-ch-num" min="0" max="100" step="1" value="${pct}"
        style="width:56px;text-align:center" />
    <span style="opacity:.6;font-size:.9em;flex-shrink:0">%</span>
</div>
<small class="trg-hint">Fires with this probability each generation. Combine with AND logic to make any rule probabilistic.</small>`);

        const $range = $el.find('.trg-ch-range');
        const $num   = $el.find('.trg-ch-num');
        const emit   = () => onChange({ ...config, chance: Number($num.val()) });
        $range.on('input', function () { $num.val(this.value); emit(); });
        $num.on('input',   function () { $range.val(this.value); emit(); });
    },
};
