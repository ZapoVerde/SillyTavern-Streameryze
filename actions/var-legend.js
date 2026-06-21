/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/var-legend.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — variable chip legend rendered above prompt inputs
 * @description
 * Renders the click-to-inject variable chip legend shown above prompt inputs in
 * action renderConfig panels. System vars (gray) are always available. Rule-produced
 * vars (amber) come from prior actions in the same rule that have config.outputVar set.
 *
 * Does not reference ACTION_REGISTRY. Callers are responsible for populating
 * priorActions[].label before passing the array in — index.js does this when
 * building the ctx object passed to renderConfig.
 *
 * @api-declaration
 * renderVarLegend(priorActions, crossRuleVars, globalVars) — returns HTML string for the variable chip legend
 *
 * @contract
 *   assertions:
 *     purity:          pure given inputs; reads no external state
 *     state_ownership: none
 *     external_io:     none
 */

import { esc } from './text.js';

export function renderVarLegend(priorActions, crossRuleVars, globalVars) {
    const sys = [
        { n: 'keyword',     h: 'matched keyword' },
        { n: 'up-to',       h: 'text before keyword' },
        { n: 'message',     h: 'full message (postMessage)' },
        { n: 'paragraph',   h: 'paragraph containing keyword' },
        { n: 'history:2',       h: 'last 2 turn-pairs of chat history — replace 2 with a literal count or {{varName}}' },
        { n: 'char',        h: 'character name' },
        { n: 'user',        h: 'user name' },
        { n: 'chat_id',     h: 'current chat file name — stable per-chat identifier' },
        { n: 'highlighted', h: 'text selected when a badge button was clicked' },
    ];
    const lb = [
        { n: 'lbContent:*:*:*:all:active',
          d: '{{lbContent:*:*:*:<b>all</b>:<b>active</b>}}',
          h: 'lorebook entry content — args: lbname:title:tag:mode(first|last|rnd|all):scope(active|inactive|all); * matches any; bare text=literal, {{var}}=var ref' },
    ];
    const ps = [
        { n: 'psContent:*:first',
          d: '{{psContent:*:<b>first</b>}}',
          h: 'live prompt layer content — args: name-filter:mode(first|last|all); * matches any; bare text=literal, {{var}}=var ref (postMessage only)' },
    ];
    // Deduplicate rule vars (last write to a name wins) then strip from cross-rule/global any name already in rule
    const ruleDeduped  = Object.values(
        Object.fromEntries(
            (priorActions ?? [])
                .filter(a => a.config?.outputVar)
                .map(a => [a.config.outputVar, { n: a.config.outputVar, h: `from ${a.label ?? a.type}` }])
        )
    );
    const ruleNames    = new Set(ruleDeduped.map(v => v.n));
    const globalDeduped = Object.values(
        Object.fromEntries(
            (crossRuleVars ?? [])
                .filter(v => !ruleNames.has(v.n))
                .map(v => [v.n, v])
        )
    );
    const shownNames   = new Set([...ruleNames, ...globalDeduped.map(v => v.n)]);
    const gvarDeduped  = Object.values(
        Object.fromEntries(
            (globalVars ?? [])
                .filter(v => !shownNames.has(v.n))
                .map(v => [v.n, v])
        )
    );

    const chip = (v, cls) =>
        `<span class="trg-var-chip ${cls} trg-var-inject" data-token="{{${esc(v.n)}}}" title="${esc(v.h)}">${v.d ?? `{{${esc(v.n)}}}`}</span>`;
    const chips = `<div class="trg-var-legend">${
        sys.map(v => chip(v, 'trg-var-chip-sys')).join('')
    }<span class="trg-var-legend-sep"></span>${lb.map(v => chip(v, 'trg-var-chip-lb')).join('')
    }<span class="trg-var-legend-sep"></span>${ps.map(v => chip(v, 'trg-var-chip-ps')).join('')
    }${ruleDeduped.length   ? `<span class="trg-var-legend-sep"></span>${ruleDeduped.map(v => chip(v, 'trg-var-chip-rule')).join('')}`     : ''
    }${globalDeduped.length ? `<span class="trg-var-legend-sep"></span>${globalDeduped.map(v => chip(v, 'trg-var-chip-global')).join('')}` : ''
    }${gvarDeduped.length   ? `<span class="trg-var-legend-sep"></span>${gvarDeduped.map(v => chip(v, 'trg-var-chip-gvar')).join('')}`    : ''}</div>`;
    return `<div class="inline-drawer trg-var-legend-drawer">
<div class="inline-drawer-toggle inline-drawer-header trg-var-legend-toggle">
    Clickable variables <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
</div>
<div class="inline-drawer-content">${chips}</div>
</div>`;
}
