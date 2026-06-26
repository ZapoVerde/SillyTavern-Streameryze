/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/transforms.js
 * @stamp {"utc":"2026-06-17T00:00:00.000Z"}
 * @architectural-role IO — string transform token resolution
 * @description
 * Resolves {{transform: ...}} tokens in template strings after variable substitution.
 * Each transform accepts a resolved string value and returns a transformed string.
 * Called as the final step in interpolate(), after {{math:}} evaluation.
 * Inner {{varName}} references are resolved by interpolate() before this runs.
 *
 * @api-declaration
 * resolveTransforms(template)   — replace all {{transform:...}} tokens with their results
 * TRANSFORM_PREFIXES            — prefix strings that must be deferred in the first interpolation pass
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: none
 *     external_io:     none
 */

import { trgLog }        from '../logger.js';
import { jaroWinkler }   from '../triggers/kw-match.js';

export const TRANSFORM_PREFIXES = [
    'trim:', 'upper:', 'lower:', 'lines:', 'words:', 'default:',
    'chars:', 'last:', 'nth:', 'cap:', 'len:', 'join:', 'replace:', 'match:', 'bar:', 'pad:', 'pick:',
    'hideFromUser:', 'fuzzy:',
];

export function resolveTransforms(template) {
    if (!template) return template;

    // {{trim: val}} / {{upper: val}} / {{lower: val}} / {{cap: val}} / {{len: val}}
    template = template.replace(/\{\{(trim|upper|lower|cap|len):\s*([\s\S]*?)\}\}/g, (_, fn, val) => {
        if (fn === 'trim')  return val.trim();
        if (fn === 'upper') return val.toUpperCase();
        if (fn === 'lower') return val.toLowerCase();
        if (fn === 'cap')   return val.charAt(0).toUpperCase() + val.slice(1);
        return String(val.length); // len
    });

    // {{lines: N: val}} — first N lines; {{words: N: val}} — first N whitespace-separated tokens
    template = template.replace(/\{\{(lines|words):\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, fn, n, val) => {
        const count = Math.max(1, parseInt(n, 10));
        if (fn === 'lines') return val.split('\n').slice(0, count).join('\n');
        return val.trim().split(/\s+/).slice(0, count).join(' ');
    });

    // {{chars: N: val}} — first N characters (N=0 returns empty string)
    template = template.replace(/\{\{chars:\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, n, val) =>
        val.slice(0, parseInt(n, 10)),
    );

    // {{last: N: val}} — last N lines
    template = template.replace(/\{\{last:\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, n, val) => {
        const count = Math.max(1, parseInt(n, 10));
        return val.split('\n').slice(-count).join('\n');
    });

    // {{nth: N: val}} — line N, 1-based; empty string if out of range
    template = template.replace(/\{\{nth:\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, n, val) => {
        const idx = Math.max(1, parseInt(n, 10)) - 1;
        return val.split('\n')[idx] ?? '';
    });

    // {{default: fallback: val}} — return val if non-empty after trim, otherwise fallback.
    // Fallback may not contain a colon. val is typically a resolved {{varName}} reference.
    template = template.replace(/\{\{default:\s*(.*?):\s*([\s\S]*?)\}\}/g, (_, fallback, val) =>
        val.trim() ? val : fallback,
    );

    // {{join: delim: val}} — join non-empty lines with delimiter. Delim may not contain a colon.
    // One optional leading space after join: is consumed as visual padding; the rest is the literal delimiter.
    template = template.replace(/\{\{join:\s?(.*?):\s*([\s\S]*?)\}\}/g, (_, delim, val) =>
        val.split('\n').filter(s => s.trim()).join(delim),
    );

    // {{replace: find: with: val}} — literal find/replace, all occurrences.
    // find and with may not contain a colon.
    template = template.replace(/\{\{replace:\s*(.*?):\s*(.*?):\s*([\s\S]*?)\}\}/g, (_, find, repl, val) =>
        find ? val.split(find).join(repl) : val,
    );

    // {{match: /pattern/flags: val}} — first capture group, or full match if no groups; '' if no match.
    // Pattern must use /pattern/flags syntax; colons inside the pattern are fine.
    template = template.replace(/\{\{match:\s*(\/(?:[^/\\]|\\.)*\/[gimsuy]*):\s*([\s\S]*?)\}\}/g, (_, pat, val) => {
        try {
            const m = /^\/(.*)\/([gimsuy]*)$/.exec(pat);
            const re = new RegExp(m[1], m[2]);
            const hit = re.exec(val);
            return hit ? (hit[1] ?? hit[0]) : '';
        } catch { return ''; }
    });

    // {{pad: N : val}} — right-pad val with spaces to N characters. Truncates with '…' if longer.
    template = template.replace(/\{\{pad:\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, n, val) => {
        const w = parseInt(n, 10);
        if (val.length > w) return val.slice(0, w - 1) + '…';
        return val + ' '.repeat(w - val.length);
    });

    // {{pick: N: val}} — N random non-empty lines from val, newline-joined
    template = template.replace(/\{\{pick:\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, n, val) => {
        const count = Math.max(1, parseInt(n, 10));
        const lines = val.split('\n').filter(s => s.trim());
        if (!lines.length) return '';
        for (let i = lines.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [lines[i], lines[j]] = [lines[j], lines[i]];
        }
        return lines.slice(0, count).join('\n');
    });

    // {{bar: value : bucketSize : max }} — colon bar chart.
    // One ':' per full bucket. Remainder > 20% of bucket appends '.'. Overflow appends '+'.
    template = template.replace(/\{\{bar:\s*([\d.]+)\s*:\s*([\d.]+)\s*:\s*([\d.]+)\s*\}\}/g, (_, val, bucket, maxCols) => {
        const n = parseFloat(val);
        const b = parseFloat(bucket);
        const m = parseInt(maxCols, 10);
        if (!Number.isFinite(n) || !Number.isFinite(b) || b <= 0 || !Number.isFinite(m) || m <= 0) return '';
        if (n >= b * m) return ':'.repeat(m) + '+';
        const full = Math.floor(n / b);
        const result = ':'.repeat(full) + (n % b > b * 0.2 ? '.' : '');
        trgLog('bar transform', { val, bucket, maxCols, result });
        return result;
    });
    // {{fuzzy:threshold:candidates:query}} — returns the best-matching candidate via Jaro-Winkler.
    // threshold is 0-100 integer (default 80). candidates are comma-separated. query is last
    // so colons inside it cannot shift earlier positions. Returns '' if no candidate scores at
    // or above threshold, or if query/candidates are empty.
    template = template.replace(/\{\{fuzzy:([\s\S]*?)\}\}/g, (_, content) => {
        const parts      = content.split(':');
        const rawThresh  = (parts[0] ?? '').trim();
        const candidates = (parts[1] ?? '').trim();
        const query      = parts.slice(2).join(':').trim();
        if (!query || !candidates) return '';
        const thresh = Number.isFinite(parseFloat(rawThresh)) ? parseFloat(rawThresh) / 100 : 0.80;
        const q      = query.toLowerCase();
        const best   = candidates.split(',')
            .map(c => c.trim()).filter(Boolean)
            .map(c => ({ c, score: jaroWinkler(q, c.toLowerCase()) }))
            .filter(x => x.score >= thresh)
            .sort((a, b) => b.score - a.score)[0];
        return best?.c ?? '';
    });

    // {{hideFromUser: text}} — wraps content in a <details> spoiler in the chat UI.
    // <details> is block-level so multi-paragraph content with blank lines works (showdown passes block HTML raw).
    // The element survives to msg.mes so the LLM still sees it in context (as raw HTML).
    // No class attribute: keeps the LLM-visible markup minimal; native <details> behaviour handles hide/show.
    template = template.replace(/\{\{hideFromUser:\s*([\s\S]*?)\}\}/g, (_, val) =>
        `<details><summary>▸</summary>${val}</details>`,
    );

    // debug: flag any unresolved {{bar:}} tokens that didn't match (non-numeric first arg)
    if (template.includes('{{bar:')) {
        const unresolved = template.match(/\{\{bar:[^}]*\}\}/g) ?? [];
        if (unresolved.length) trgLog('bar unresolved tokens', unresolved);
    }

    return template;
}
