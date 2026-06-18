/**
 * @file st-extensions/SillyTavern-Triggeryze/triggers/domEvent.js
 * @stamp {"utc":"2026-06-18T12:00:00.000Z"}
 * @architectural-role Registry — domEvent trigger entry
 * @description
 * Trigger that fires when a DOM CustomEvent matching config.eventName is dispatched.
 * Owns _currentDomEventName and _currentDomEventDetail — set by the engine before
 * a domEvent rule pass and cleared immediately after.
 *
 * The engine also pre-populates turn variables with the event detail fields so
 * that actions can reference {{dom_event_uuid}}, {{dom_event_status}},
 * {{dom_event_path}}, and {{dom_event_error}} via standard template interpolation.
 *
 * @api-declaration
 * domEventTrigger                          — trigger registry entry object
 * setCurrentDomEvent(name, detail)         — called by engine before a domEvent rule pass
 * clearCurrentDomEvent()                   — called by engine after the pass
 *
 * @contract
 *   assertions:
 *     purity:          test() is read-only; no side effects
 *     state_ownership: [_currentDomEventName, _currentDomEventDetail]
 *     external_io:     none
 */

import { esc } from '../actions/text.js';

let _currentDomEventName   = '';
let _currentDomEventDetail = null;

export function setCurrentDomEvent(name, detail) {
    _currentDomEventName   = name;
    _currentDomEventDetail = detail;
}
export function clearCurrentDomEvent() {
    _currentDomEventName   = '';
    _currentDomEventDetail = null;
}

export const domEventTrigger = {
    label: 'DOM event',
    defaultConfig: { eventName: 'plz:rmbg-done' },

    async test(_text, config) {
        const name = config.eventName?.trim() ?? '';
        if (!name || _currentDomEventName !== name) return null;
        return name;
    },

    renderConfig($el, config, onChange) {
        const name = config.eventName ?? 'plz:rmbg-done';
        $el.html(`
<div style="display:flex;flex-direction:column;gap:6px">
    <input type="text" class="trg-dom-event-name text_pole"
        placeholder="e.g. plz:rmbg-done"
        value="${esc(name)}"
        style="font-size:.85em" />
    <small class="trg-hint">
        Fires when <code>document.dispatchEvent(new CustomEvent('${esc(name)}', ...))</code> is called.
        Turn variables populated on match:
        <code>{{dom_event_uuid}}</code>, <code>{{dom_event_status}}</code>,
        <code>{{dom_event_path}}</code>, <code>{{dom_event_error}}</code>.
    </small>
</div>`);

        $el.find('.trg-dom-event-name').on('input', function () {
            const newName = this.value;
            $el.find('.trg-hint code').first().text(`document.dispatchEvent(new CustomEvent('${newName}', ...))`);
            onChange({ ...config, eventName: newName });
        });
    },
};
