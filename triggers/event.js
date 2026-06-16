/**
 * @file triggers/event.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — event trigger entry
 * @description
 * Trigger that fires when the active ST event name matches the configured event.
 * Owns _currentEvent — the name set by the engine before each event-trigger pass
 * and cleared immediately after. The engine imports setCurrentEvent/clearCurrentEvent
 * from this file.
 *
 * @api-declaration
 * eventTrigger                 — trigger registry entry object
 * setCurrentEvent(name)        — called by engine before an event-trigger rule pass
 * clearCurrentEvent()          — called by engine after the pass
 *
 * @contract
 *   assertions:
 *     purity:          test() is read-only; no side effects
 *     state_ownership: [_currentEvent]
 *     external_io:     none
 */

let _currentEvent = '';

export function setCurrentEvent(name) { _currentEvent = name; }
export function clearCurrentEvent()   { _currentEvent = ''; }

export const eventTrigger = {
    label: 'event',
    defaultConfig: { event: 'MESSAGE_RECEIVED' },
    async test(_text, config) {
        const ev = config.event ?? '';
        return _currentEvent === ev && ev ? ev : null;
    },
    renderConfig($el, config, onChange) {
        const ev = config.event ?? 'MESSAGE_RECEIVED';
        const hints = {
            MESSAGE_RECEIVED:           'Fires once after each AI message is fully received. Replaces the legacy "chat complete" trigger.',
            GENERATION_STARTED:         'Fires when a new AI turn begins, before any tokens arrive. Use to clear variables or prepare state for the coming turn.',
            CHARACTER_MESSAGE_RENDERED: 'Fires each time a message is rendered to the DOM, including on chat reload. Use with care — may run for every message on page load.',
        };
        $el.html(`
<div style="display:flex;flex-direction:column;gap:6px">
    <select class="trg-event-name" style="font-size:.85em">
        <option value="MESSAGE_RECEIVED"           ${ev === 'MESSAGE_RECEIVED'           ? 'selected' : ''}>chat complete</option>
        <option value="GENERATION_STARTED"         ${ev === 'GENERATION_STARTED'         ? 'selected' : ''}>generation started</option>
        <option value="CHARACTER_MESSAGE_RENDERED" ${ev === 'CHARACTER_MESSAGE_RENDERED' ? 'selected' : ''}>message rendered</option>
    </select>
    <small class="trg-event-hint trg-hint">${hints[ev] ?? ''}</small>
</div>`);
        $el.find('.trg-event-name').on('change', function () {
            const newEv = this.value;
            $el.find('.trg-event-hint').text(hints[newEv] ?? '');
            onChange({ ...config, event: newEv });
        });
    },
};
