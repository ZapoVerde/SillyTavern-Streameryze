/**
 * @file st-extensions/SillyTavern-Streameryze/badge.js
 * @architectural-role UI / Per-Message Status Badge
 * @description
 * Injects a small status pill after each AI message's .ch_name row.
 * States: unchanged (neutral) | thinking (red pulse) | modified (green).
 *
 * @api-declaration
 * ensureBadge(messageId)   — injects badge if not present; no-op for user messages
 * setBadge(messageId, state) — 'unchanged' | 'thinking' | 'modified'
 * removeAllBadges()        — strips all badges from DOM (called on disable)
 * reinjectAllBadges()      — refreshes all AI messages (called on chat change)
 *
 * @contract
 *   assertions:
 *     purity:          UI only — no rule evaluation, no settings mutation
 *     state_ownership: none
 *     external_io:     DOM (.mes[mesid] .ch_name)
 */

import { extension_settings } from '../../../extensions.js';

const EXT_NAME = 'streameryze';

function isEnabled() {
    return extension_settings[EXT_NAME]?.showBadges !== false;
}

const ICONS = {
    unchanged: 'fa-bolt',
    thinking:  'fa-circle-notch fa-spin',
    modified:  'fa-pen',
};

export function ensureBadge(messageId) {
    if (!isEnabled()) return;
    const $mes = $(`.mes[mesid="${messageId}"]`);
    if (!$mes.length) return;

    const stCtx = window.SillyTavern?.getContext?.();
    if (stCtx?.chat?.[messageId]?.is_user) return;

    if ($mes.find('.smz-badge').length) return;

    const $badge = $(`
<div class="smz-badge smz-badge-unchanged">
    <i class="fa-solid ${ICONS.unchanged}"></i>
    <span class="smz-badge-text">unchanged</span>
</div>`);
    const $chName = $mes.find('.ch_name');
    if ($chName.length) $chName.after($badge);
}

export function setBadge(messageId, state) {
    ensureBadge(messageId);
    const $badge = $(`.mes[mesid="${messageId}"] .smz-badge`);
    if (!$badge.length) return;
    $badge
        .removeClass('smz-badge-unchanged smz-badge-thinking smz-badge-modified')
        .addClass(`smz-badge-${state}`);
    $badge.find('i').attr('class', `fa-solid ${ICONS[state] ?? ICONS.unchanged}`);
    $badge.find('.smz-badge-text').text(state);
}

export function removeAllBadges() {
    $('.smz-badge').remove();
}

export function reinjectAllBadges() {
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => ensureBadge(idx));
}
