/**
 * @file st-extensions/SillyTavern-Triggeryze/index.js
 * @stamp {"utc":"2026-06-20T00:00:00.000Z"}
 * @architectural-role Orchestrator — extension entry point and event wiring
 * @description
 * Loads settings, registers all ST event listeners, and mounts the settings panel.
 * Contains no logic of its own — delegates entirely to engine.js, badge.js, and
 * the settings/ modules.
 *
 * @api-declaration
 * (none — this module is an entry point, not a library)
 *
 * @contract
 *   assertions:
 *     purity:          none — calls loadSettings and wires eventSource listeners
 *     state_ownership: [_badgeHighlight, _badgeMesId]
 *     external_io:     eventSource
 */

import { eventSource, event_types }                                        from '../../../../script.js';
import { onGenerationStarted, onStreamToken, onMessageReceived, onCharacterMessageRendered, onMessageSwiped, onChatLoaded, fireRuleManually, cancelCurrentOperations, reinjectRuleBadges, reinjectInlineBadges } from './engine.js';
import { clearAllMessageBadges, setBadge, reinjectAllBadges, removeAllBadges } from './badge.js';
import { loadSettings }                                                     from './settings/storage.js';
import { addSettingsPanel }                                                from './settings/panel.js';
import { reportTrgPresets }                                                from './actions/preset.js';

loadSettings();

eventSource.on(event_types.GENERATION_STARTED,         onGenerationStarted);
eventSource.on(event_types.STREAM_TOKEN_RECEIVED,       onStreamToken);
eventSource.on(event_types.MESSAGE_RECEIVED,            onMessageReceived);
eventSource.on(event_types.CHAT_CHANGED, () => {
    reinjectAllBadges();
    reinjectRuleBadges();
    reinjectInlineBadges();
    reportTrgPresets();
    onChatLoaded();
});
// Badge injection and the _prevTurnAiId demolition guard both live inside
// onCharacterMessageRendered so all badge-related logic for this event stays
// in one place rather than being split between here and engine.js.
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
    // Clear all badge types immediately so stale badges from the outgoing variant
    // don't linger until the first token of the regeneration arrives.
    clearAllMessageBadges(messageId);
    onMessageSwiped(messageId);
});

$(document).on('click', '.trg-badge', async function () {
    const messageId = parseInt($(this).closest('.mes').attr('mesid'), 10);
    if (isNaN(messageId)) return;
    if ($(this).hasClass('trg-badge-thinking')) {
        cancelCurrentOperations();
        return;
    }
    setBadge(messageId, 'unchanged');
    await onMessageReceived(messageId);
});

function injectToInput(text, andSend) {
    $('#send_textarea').val(text)[0].dispatchEvent(new Event('input', { bubbles: true }));
    if (andSend) $('#send_but').trigger('click');
}

// mousedown fires before focus shifts, preserving the text selection
let _badgeHighlight = '';
let _badgeMesId     = NaN;
$(document).on('mousedown touchstart', '.trg-rule-badge, .trg-inline-badge', function () {
    _badgeHighlight = window.getSelection()?.toString().trim() ?? '';
    _badgeMesId     = parseInt($(this).closest('.mes').attr('mesid'), 10);
});

$(document).on('click', '.trg-rule-badge', async function () {
    const ruleId      = $(this).data('rule-id');
    const messageId   = parseInt($(this).data('mesid'), 10);
    const clickAction = $(this).data('click-action') || 'fire';
    const payload     = $(this).data('payload') || '';
    const highlighted = _badgeHighlight;
    _badgeHighlight   = '';
    _badgeMesId       = NaN;
    if (!ruleId || isNaN(messageId)) return;
    if (clickAction === 'fire')         await fireRuleManually(ruleId, messageId, highlighted, payload || null);
    else if (clickAction === 'inject')       injectToInput(payload, false);
    else if (clickAction === 'inject-send')  injectToInput(payload, true);
});

$(document).on('click', '.trg-inline-badge', async function () {
    const ruleId      = $(this).data('rule-id');
    const messageId   = parseInt($(this).closest('.mes').attr('mesid'), 10);
    const matchedKw   = $(this).data('kw');
    const clickAction = $(this).data('click-action') || 'fire';
    _badgeHighlight   = '';
    _badgeMesId       = NaN;
    if (!ruleId || isNaN(messageId)) return;
    if (clickAction === 'fire')         await fireRuleManually(ruleId, messageId, matchedKw, matchedKw);
    else if (clickAction === 'inject')       injectToInput(matchedKw, false);
    else if (clickAction === 'inject-send')  injectToInput(matchedKw, true);
});

addSettingsPanel();
