/**
 * @file st-extensions/SillyTavern-Triggeryze/badge.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role UI — all per-message badge rendering (status, rule, inline)
 * @description
 * Renders all badge types for AI messages: the generation status pill; top and bottom
 * rule badge buttons driven by the unified badge trigger; and inline keyword spans that
 * wrap matched text in .mes_text. Absorbs the former inline-badge.js — there is no
 * longer a separate inline badge module.
 *
 * Every user-facing string field (label, color, keywords) resolves {{varName}} against
 * the current turn variable snapshot before rendering (Principle 15).
 *
 * @api-declaration
 * ensureBadge(messageId)               — inject status pill; no-op for user messages
 * setBadge(messageId, state)           — 'unchanged' | 'thinking' | 'modified'
 * renderRuleBadges(messageId, defs)    — render top/bottom badge buttons for a message
 * clearRuleBadges(messageId)           — remove rule badge buttons from one message
 * clearAllMessageBadges(messageId)     — remove every TRG badge type from one message (turn teardown)
 * removeAllBadges()                    — strip all TRG badges from DOM (called on disable)
 * reinjectAllBadges()                  — refresh status badges for all AI messages
 * injectInlineBadges(messageId, defs)  — strip and re-inject inline keyword badges
 * removeAllInlineBadges()              — unwrap all inline badge spans across the DOM
 * reinjectAllInlineBadges(defs)        — resolve patterns once, re-inject inline badges for every AI message (async)
 * injectPatternsIntoEl(el, patterns)   — inject pre-built patterns into a DOM element (sync)
 * buildResolvedPatterns(defs)          — resolve keyword defs to ready patterns (async)
 *
 * @contract
 *   assertions:
 *     purity:          UI only — no rule evaluation, no settings mutation
 *     state_ownership: none
 *     external_io:     DOM (.mes[mesid] .ch_name, .mes_text, .trg-bottom-badges)
 */

import { extension_settings }                        from '../../../extensions.js';
import { resolveLbQueryTokens }  from './triggers/lb-query.js';
import { getTurnVarsSnapshot }   from './triggers/turn-vars.js';
import { parseRegexPattern, fuzzyMatchText } from './triggers/kw-match.js';
import { trgLog }                from './logger.js';

const EXT_NAME = 'triggeryze';

// ─── Shared utilities ────────────────────────────────────────────────────────

function isEnabled() {
    return extension_settings[EXT_NAME]?.showBadges !== false;
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/** Return a text-safe version of hex with lightness clamped to [floor, ceil] in HSL. */
function clampTextColor(hex, floor = 60, ceil = 88) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let s = 0, h = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    const clamped = Math.min(ceil, Math.max(floor, Math.round(l * 100)));
    return `hsl(${Math.round(h * 360)},${Math.round(s * 100)}%,${clamped}%)`;
}

/** Replace {{varName}} tokens with current turn variable values (Principle 15). */
function expandVars(str, snapshot) {
    return String(str ?? '').replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
        const v = snapshot[k.trim()];
        return v !== undefined ? String(v) : '';
    });
}

/** Interpret escape sequences in a splitOn string typed in the UI (e.g. \n → newline). */
function parseSplitOn(raw) {
    if (!raw) return null;
    return raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
}

// ─── Status badge ────────────────────────────────────────────────────────────

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
    if ($mes.find('.trg-badge').length) return;
    const $badge = $(`
<div class="trg-badge trg-badge-unchanged">
    <i class="fa-solid ${ICONS.unchanged}"></i>
    <span class="trg-badge-text">unchanged</span>
</div>`);
    const $chName = $mes.find('.ch_name');
    if ($chName.length) $chName.after($badge);
}

export function setBadge(messageId, state) {
    ensureBadge(messageId);
    const $badge = $(`.mes[mesid="${messageId}"] .trg-badge`);
    if (!$badge.length) return;
    $badge
        .removeClass('trg-badge-unchanged trg-badge-thinking trg-badge-modified')
        .addClass(`trg-badge-${state}`);
    $badge.find('i').attr('class', `fa-solid ${ICONS[state] ?? ICONS.unchanged}`);
    $badge.find('.trg-badge-text').text(state);
    if (state === 'thinking') $badge.attr('title', 'Click to cancel');
    else $badge.removeAttr('title');
}

// ─── Rule badge buttons (top & bottom) ───────────────────────────────────────

function makeRuleBadgeButton(ruleId, messageId, label, color, clickAction, compact) {
    return $(`<button class="trg-rule-badge${compact ? ' trg-compact' : ''}"
        data-rule-id="${esc(ruleId)}"
        data-mesid="${messageId}"
        data-click-action="${esc(clickAction || 'fire')}"
        data-payload="${esc(label)}"
        style="background:${hexToRgba(color, .15)};border-color:${hexToRgba(color, .45)};color:${clampTextColor(color)}"
        title="${esc(label)}">${esc(label)}</button>`);
}

/**
 * Render per-rule badge buttons for a message.
 * defs: [{ ruleId, label, color, style, splitOn, clickAction }]
 *
 * label and color support {{varName}} (Principle 15).
 * splitOn splits the resolved label into N badges.
 * style 'bottom' → stacked in .trg-bottom-badges appended inside .mes_text.
 * style 'top'    → inline row after .ch_name (default).
 * graph: true    → applies monospace/pre font to badges in either top or bottom position.
 */
export function renderRuleBadges(messageId, defs) {
    trgLog('badge renderRuleBadges', { messageId, defs: defs?.length ?? 0 });
    const $mes = $(`.mes[mesid="${messageId}"]`);
    if (!$mes.length) { trgLog('badge renderRuleBadges — no .mes element', { messageId }); return; }
    const stCtx = window.SillyTavern?.getContext?.();
    if (stCtx?.chat?.[messageId]?.is_user) { trgLog('badge renderRuleBadges — user message, skip'); return; }

    $mes.find('.trg-rule-badge').remove();
    $mes.find('.trg-bottom-badges').remove();
    if (!defs?.length) { trgLog('badge renderRuleBadges — no defs, cleared only', { messageId }); return; }

    const snapshot = getTurnVarsSnapshot();
    const topItems = [];
    const btmItems = [];

    for (const def of defs) {
        const resolvedLabel = expandVars(def.label ?? 'run', snapshot);
        const rawColor      = expandVars(def.color ?? '#8888ff', snapshot);
        const color         = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#8888ff';
        const splitChar     = parseSplitOn(def.splitOn ?? '');
        const clickAction   = def.clickAction || 'fire';

        const labels = splitChar && resolvedLabel
            ? resolvedLabel.split(splitChar).map(s => s.trim()).filter(Boolean)
            : [resolvedLabel || 'run'];

        const bucket = def.style === 'bottom' ? btmItems : topItems;
        for (const label of labels) {
            bucket.push({ ruleId: def.ruleId, label, color, clickAction, graph: def.graph === true, compact: def.compact === true });
        }
    }

    if (topItems.length) {
        const $chName = $mes.find('.ch_name');
        if ($chName.length) {
            let $ref = $mes.find('.trg-badge').length ? $mes.find('.trg-badge') : $chName;
            for (const item of topItems) {
                const $btn = makeRuleBadgeButton(item.ruleId, messageId, item.label, item.color, item.clickAction, item.compact);
                if (item.graph) $btn.addClass('trg-graph');
                $ref.after($btn);
                $ref = $btn;
            }
        }
    }

    if (btmItems.length) {
        const $mesText = $mes.find('.mes_text');
        if ($mesText.length) {
            const isGraph    = btmItems.some(i => i.graph);
            const $container = $(`<div class="trg-bottom-badges${isGraph ? ' trg-graph' : ''}" aria-hidden="true"></div>`);
            $mesText.after($container);
            for (const item of btmItems) {
                $container.append(makeRuleBadgeButton(item.ruleId, messageId, item.label, item.color, item.clickAction, item.compact));
            }
        }
    }
}

export function removeAllBadges() {
    $('.trg-badge').remove();
}

export function clearRuleBadges(messageId) {
    const $mes = $(`.mes[mesid="${messageId}"]`);
    $mes.find('.trg-rule-badge').remove();
    $mes.find('.trg-bottom-badges').remove();
}

/**
 * Atomically remove all TRG badge elements from a single AI message.
 *
 * This is the only badge teardown call needed at turn boundaries. All three
 * badge types are handled in one place so no type can be silently missed:
 *   .trg-badge          — status pill (unchanged / thinking / modified)
 *   .trg-rule-badge     — top-row action buttons
 *   .trg-bottom-badges  — bottom badge container and its buttons
 *   .trg-inline-badge   — keyword spans wrapped inside .mes_text
 *
 * Called from engine.js on first token (to demolish the previous turn) and
 * from the MESSAGE_SWIPED handler (to clear the outgoing variant before
 * regeneration begins). Do NOT call this on the currently streaming message.
 */
export function clearAllMessageBadges(messageId) {
    const $mes = $(`.mes[mesid="${messageId}"]`);
    $mes.find('.trg-badge').remove();
    $mes.find('.trg-rule-badge').remove();
    $mes.find('.trg-bottom-badges').remove();
    // Unwrap inline spans — replaceWith preserves their text content in the DOM.
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (mesText) stripInlineBadges(mesText);
}

export function reinjectAllBadges() {
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => ensureBadge(idx));
}

// ─── Inline badge removal watcher (debug) ────────────────────────────────────

let _removalWatcher = null;
export function startInlineBadgeRemovalWatcher() {
    if (_removalWatcher) return;
    _removalWatcher = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.removedNodes) {
                const spans = node.nodeType === 1 && node.classList?.contains('trg-inline-badge')
                    ? [node]
                    : (node.nodeType === 1 ? [...node.querySelectorAll('.trg-inline-badge')] : []);
                if (!spans.length) continue;
                const mesEl = m.target.closest?.('[mesid]');
                console.warn(`[TRG:badge:REMOVAL] ${spans.length} inline badge(s) removed from mesId=${mesEl?.getAttribute('mesid') ?? '?'} kw=${spans.map(s => s.dataset?.kw).join(',')}`, new Error('removal stack').stack);
            }
        }
    });
    _removalWatcher.observe(document.body, { childList: true, subtree: true });
    trgLog('badge inline removal watcher started');
}
export function stopInlineBadgeRemovalWatcher() {
    _removalWatcher?.disconnect();
    _removalWatcher = null;
    trgLog('badge inline removal watcher stopped');
}

// ─── Inline keyword badges (absorbed from inline-badge.js) ───────────────────

function stripInlineBadges(root) {
    for (const span of root.querySelectorAll('.trg-inline-badge')) {
        span.replaceWith(document.createTextNode(span.textContent));
    }
    root.normalize();
}

function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.parentElement?.closest('pre, code, .trg-inline-badge, .trg-bottom-badges')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
}

function buildKeywordPatterns(defs) {
    const patterns = [];
    for (const def of defs) {
        const safeColor = def.color && /^#[0-9a-fA-F]{6}$/.test(def.color) ? def.color : '#8888ff';
        const matchMode = def.matchMode ?? (def.useRegex ? 'regex' : 'keyword');
        if (matchMode === 'regex') {
            const re = parseRegexPattern(def.pattern ?? '');
            if (!re) continue;
            const flags = re.flags.includes('g') ? re.flags : `g${re.flags}`;
            patterns.push({
                re:          new RegExp(re.source, flags),
                ruleId:      def.ruleId,
                color:       safeColor,
                clickAction: def.clickAction || 'fire',
                badgeLabel:  def.badgeLabel ?? '',
            });
            continue;
        }
        if (matchMode === 'fuzzy') {
            const kws    = (def.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
            const rawNum = parseFloat(def.fuzzyThreshold ?? '80');
            const thresh = Number.isFinite(rawNum) ? rawNum / 100 : 0.80;
            patterns.push({
                fuzzy:       true,
                keywords:    kws,
                threshold:   thresh,
                ruleId:      def.ruleId,
                color:       safeColor,
                clickAction: def.clickAction || 'fire',
                badgeLabel:  def.badgeLabel ?? '',
            });
            continue;
        }
        const kws = (def.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
        for (const kw of kws) {
            const escaped = kw.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                              .replace(/\*/g, '\\w*')
                              .replace(/\?/g, '\\w');
            patterns.push({
                re:          new RegExp(escaped, def.caseSensitive ? 'g' : 'gi'),
                ruleId:      def.ruleId,
                color:       safeColor,
                clickAction: def.clickAction || 'fire',
                badgeLabel:  def.badgeLabel ?? '',
            });
        }
    }
    return patterns;
}

function findMatches(text, patterns) {
    const raw = [];
    for (const pat of patterns) {
        if (pat.fuzzy) {
            for (const kw of pat.keywords) {
                const m = fuzzyMatchText(text, kw, pat.threshold);
                if (m) raw.push({ start: m.start, end: m.end, matched: m.value,
                    ruleId: pat.ruleId, color: pat.color, clickAction: pat.clickAction, badgeLabel: pat.badgeLabel });
            }
            continue;
        }
        const { re, ruleId, color, clickAction, badgeLabel } = pat;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            raw.push({ start: m.index, end: m.index + m[0].length, matched: m[0], ruleId, color, clickAction, badgeLabel });
            if (m[0].length === 0) { re.lastIndex++; break; }
        }
    }
    raw.sort((a, b) => a.start - b.start || b.end - a.end);
    const result = [];
    let cursor = 0;
    for (const m of raw) {
        if (m.start >= cursor) { result.push(m); cursor = m.end; }
    }
    return result;
}

function replaceTextNode(node, matches) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of matches) {
        if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
        if (m.badgeLabel) {
            frag.appendChild(document.createTextNode(text.slice(m.start, m.end)));
        }
        const span = document.createElement('span');
        span.className           = 'trg-inline-badge';
        span.setAttribute('aria-hidden', 'true');
        span.dataset.ruleId      = m.ruleId;
        span.dataset.kw          = m.matched;
        span.dataset.clickAction = m.clickAction || 'fire';
        span.dataset.payload     = m.matched;
        span.textContent         = m.badgeLabel ? m.badgeLabel.replace(/\{\{keyword\}\}/gi, m.matched) : m.matched;
        span.style.cssText       = `background:${hexToRgba(m.color, .15)};border-color:${hexToRgba(m.color, .45)};color:${clampTextColor(m.color)}`;
        frag.appendChild(span);
        pos = m.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
}

/** Inject pre-built patterns into an already-obtained element (sync, no strip pass). */
export function injectPatternsIntoEl(el, patterns) {
    if (!patterns?.length) return;
    for (const node of collectTextNodes(el)) {
        if (!node.parentNode) continue;
        const matches = findMatches(node.nodeValue ?? '', patterns);
        if (matches.length) replaceTextNode(node, matches);
    }
}

/** Resolve keyword strings in defs against LB data and turn vars; return ready patterns. */
export async function buildResolvedPatterns(defs) {
    if (!defs?.length) return [];
    const snapshot = getTurnVarsSnapshot();
    const resolvedDefs = await Promise.all(defs.map(async def => {
        // Protect {{keyword}} from turn-var expansion — it resolves per-match in replaceTextNode.
        const rawLabel   = (def.badgeLabel ?? '').replace(/\{\{keyword\}\}/gi, '\x01KW\x01');
        const badgeLabel = expandVars(rawLabel, snapshot).replace(/\x01KW\x01/g, '{{keyword}}');
        const matchMode  = def.matchMode ?? (def.useRegex ? 'regex' : 'keyword');
        if (matchMode === 'regex') {
            return { ...def, pattern: expandVars(def.pattern ?? '', snapshot), badgeLabel };
        }
        // keyword and fuzzy both resolve the keywords field
        const afterLb  = await resolveLbQueryTokens(def.keywords ?? '', snapshot);
        const keywords = expandVars(afterLb, snapshot);
        return { ...def, keywords, badgeLabel };
    }));
    return buildKeywordPatterns(resolvedDefs);
}

export async function injectInlineBadges(messageId, defs) {
    trgLog('badge injectInlineBadges', { messageId, defs: defs?.length ?? 0 });
    if (!defs?.length) { trgLog('badge injectInlineBadges — no defs', { messageId }); return; }
    const mesText = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!mesText) { trgLog('badge injectInlineBadges — no .mes_text', { messageId }); return; }
    stripInlineBadges(mesText);
    const patterns = await buildResolvedPatterns(defs);
    trgLog('badge injectInlineBadges patterns', { messageId, patterns: patterns.length });
    if (!patterns.length) return;
    // Re-query after async gap in case ST replaced the element.
    const liveEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`) ?? mesText;
    injectPatternsIntoEl(liveEl, patterns);
}

export function removeAllInlineBadges() {
    for (const span of document.querySelectorAll('.trg-inline-badge')) {
        span.replaceWith(document.createTextNode(span.textContent));
    }
}

export async function reinjectAllInlineBadges(defs) {
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    const patterns = await buildResolvedPatterns(defs);
    if (!patterns.length) return;
    stCtx.chat.forEach((_msg, idx) => {
        const mesText = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
        if (!mesText) return;
        stripInlineBadges(mesText);
        injectPatternsIntoEl(mesText, patterns);
    });
}
