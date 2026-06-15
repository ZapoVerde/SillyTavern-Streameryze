/**
 * @file st-extensions/SillyTavern-Triggeryze/index.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
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
 *     state_ownership: [_badgeHighlight]
 *     external_io:     eventSource
 */

import { eventSource, event_types }                                        from '../../../../script.js';
import { onGenerationStarted, onStreamToken, onMessageReceived, fireRuleManually, reinjectRuleBadges } from './engine.js';
import { ensureBadge, setBadge, reinjectAllBadges, removeAllBadges }       from './badge.js';
import { loadSettings }                                                    from './settings/storage.js';
import { addSettingsPanel }                                                from './settings/panel.js';

loadSettings();

eventSource.on(event_types.GENERATION_STARTED,         onGenerationStarted);
eventSource.on(event_types.STREAM_TOKEN_RECEIVED,       onStreamToken);
eventSource.on(event_types.MESSAGE_RECEIVED,            onMessageReceived);
eventSource.on(event_types.CHAT_CHANGED,              () => { reinjectAllBadges(); reinjectRuleBadges(); });
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED,  (messageId) => { ensureBadge(messageId); reinjectRuleBadges(messageId); });

$(document).on('click', '.trg-badge', async function () {
    const messageId = parseInt($(this).closest('.mes').attr('mesid'), 10);
    if (isNaN(messageId)) return;
    setBadge(messageId, 'unchanged');
    await onMessageReceived(messageId);
});

// mousedown fires before focus shifts, preserving the text selection
let _badgeHighlight = '';
$(document).on('mousedown touchstart', '.trg-rule-badge', function () {
    _badgeHighlight = window.getSelection()?.toString().trim() ?? '';
});
$(document).on('click', '.trg-rule-badge', async function () {
    const ruleId      = $(this).data('rule-id');
    const messageId   = parseInt($(this).data('mesid'), 10);
    const highlighted = _badgeHighlight;
    _badgeHighlight   = '';
    if (!ruleId || isNaN(messageId)) return;
    await fireRuleManually(ruleId, messageId, highlighted);
});

addSettingsPanel();
