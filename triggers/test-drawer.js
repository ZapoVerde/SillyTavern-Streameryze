/**
 * @file triggers/test-drawer.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role UI — shared collapsible test-drawer widget for trigger, badge, and action config panels
 * @description
 * Renders a "▶ test" drawer that lets users paste sample text and see either which parts
 * would be matched (triggers/badges) or what an action's resolved output would be (actions).
 * Owns the DOM structure, toggle animation, backdrop highlight sync, and scroll sync. Does
 * not own match or resolution logic — callers supply a resolveFn that maps (cfg, text) to
 * a result value.
 *
 * resolveFn(cfg, text) must return one of:
 *   { hint: string }           — config not ready (e.g. empty keywords); shown as dim status
 *   { error: string }          — config invalid (e.g. bad regex); shown as a warning
 *   { output: string }         — resolved action result (deterministic actions' preview); shown verbatim, no backdrop marks
 *   Array<{start,end,value}>   — match spans; empty array means no match found
 *
 * @api-declaration
 * testDrawerHtml()                                 → string  (HTML for the drawer element)
 * getLastAiMessage()                               → string
 * syncBackdropStyles($el)                          → void
 * attachTestDrawer($el, readFn, resolveFn)         → refreshFn
 *   readFn()              — returns current config object
 *   resolveFn(cfg, text)  — async; returns spans result (see above)
 *   refreshFn()           — call when config changes to re-run the current test text
 *
 * @contract
 *   assertions:
 *     purity:          testDrawerHtml and getLastAiMessage are read-only
 *     state_ownership: none
 *     external_io:     [window.SillyTavern.getContext (getLastAiMessage only)]
 */

import { esc } from './kw-preview.js';

export function getLastAiMessage() {
    try {
        const chat = window.SillyTavern?.getContext?.()?.chat ?? [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && chat[i].mes) return chat[i].mes;
        }
    } catch { /* */ }
    return '';
}

export function testDrawerHtml() {
    return `<div class="trg-kw-test-drawer">
        <button type="button" class="trg-kw-test-toggle">&#9658; test</button>
        <div class="trg-kw-test-body" style="display:none">
            <div class="trg-kw-test-wrap">
                <div class="trg-kw-test-backdrop" aria-hidden="true"></div>
                <textarea class="trg-kw-test-input" rows="4" placeholder="Paste text to test — leave empty to use last message"></textarea>
            </div>
            <div class="trg-kw-test-result"></div>
        </div>
    </div>`;
}

export function syncBackdropStyles($el) {
    const ta = $el.find('.trg-kw-test-input')[0];
    if (!ta) return;
    const cs = window.getComputedStyle(ta);
    const pt = parseFloat(cs.paddingTop)    + parseFloat(cs.borderTopWidth);
    const pr = parseFloat(cs.paddingRight)  + parseFloat(cs.borderRightWidth);
    const pb = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
    const pl = parseFloat(cs.paddingLeft)   + parseFloat(cs.borderLeftWidth);
    $el.find('.trg-kw-test-backdrop').css({
        padding: `${pt}px ${pr}px ${pb}px ${pl}px`,
        fontSize: cs.fontSize, fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,
    });
}

async function _run($el, readFn, resolveFn) {
    const $bd  = $el.find('.trg-kw-test-backdrop');
    const $res = $el.find('.trg-kw-test-result');
    const text = $el.find('.trg-kw-test-input').val() || getLastAiMessage();

    if (!text) {
        $bd.html('');
        $res.html('<span class="trg-test-none">No text — paste above or send a message first</span>');
        return;
    }

    const result = await resolveFn(readFn(), text);

    if (!Array.isArray(result)) {
        if (result.output !== undefined) {
            $bd.html('');
            $res.html(`<pre class="trg-test-output">${esc(result.output)}</pre>`);
            return;
        }
        $bd.html(esc(text));
        $res.html(result.error
            ? `<span class="trg-test-invalid">${esc(result.error)}</span>`
            : `<span class="trg-test-none">${esc(result.hint ?? '')}</span>`);
        return;
    }

    let html = '';
    let cursor = 0;
    for (const { start, end } of result) {
        if (start > cursor) html += esc(text.slice(cursor, start));
        html += `<mark>${esc(text.slice(start, end))}</mark>`;
        cursor = end;
    }
    if (cursor < text.length) html += esc(text.slice(cursor));
    $bd.html(html);

    if (!result.length) {
        $res.html('<span class="trg-test-none">No match</span>');
    } else {
        const extra = result.length > 1 ? ` <span class="trg-test-count">+${result.length - 1} more</span>` : '';
        $res.html(`Captured: <span class="trg-test-captured">${esc(result[0].value)}</span>${extra}`);
    }
}

export function attachTestDrawer($el, readFn, resolveFn) {
    const drawerOpen = () => $el.find('.trg-kw-test-drawer').hasClass('trg-kw-test-open');
    const refresh    = () => { if (drawerOpen()) _run($el, readFn, resolveFn); };

    $el.find('.trg-kw-test-toggle').on('click', function () {
        const $drawer = $el.find('.trg-kw-test-drawer');
        const opening = !$drawer.hasClass('trg-kw-test-open');
        $drawer.toggleClass('trg-kw-test-open', opening);
        $(this).html(opening ? '&#9660; test' : '&#9658; test');
        $drawer.find('.trg-kw-test-body').slideToggle(150, () => {
            if (opening) {
                syncBackdropStyles($el);
                _run($el, readFn, resolveFn);
            }
        });
    });
    $el.find('.trg-kw-test-input').on('input', () => _run($el, readFn, resolveFn));
    $el.find('.trg-kw-test-input').on('scroll', function () {
        $el.find('.trg-kw-test-backdrop')[0].scrollTop = this.scrollTop;
    });

    return refresh;
}
