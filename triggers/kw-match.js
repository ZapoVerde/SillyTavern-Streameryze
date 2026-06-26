/**
 * @file triggers/kw-match.js
 * @stamp {"utc":"2026-06-26T00:00:00.000Z"}
 * @architectural-role IO — keyword and regex matching shared across trigger and badge entries
 * @description
 * Centralised text-matching utilities for keyword triggers and inline badges.
 * Owns glob-to-regex conversion, /pattern/flags parsing, single-keyword matching,
 * regex testing, Jaro-Winkler fuzzy matching, and all-match span enumeration (used
 * by the UI test drawer). No external state is read; all functions are pure.
 *
 * @api-declaration
 * globToRegex(pattern, caseSensitive)                              → RegExp
 * parseRegexPattern(str)                                           → RegExp | null
 * matchKeyword(text, kw, caseSensitive)                            → string | null
 * testRegex(text, patternStr)                                      → string | null
 * jaroWinkler(a, b)                                                → number  0..1
 * fuzzyMatchText(text, keyword, threshold)                         → {start,end,value} | null
 * findAllMatches(text, { useRegex, pattern,
 *                        resolvedKeywords, caseSensitive,
 *                        useFuzzy, fuzzyKeywords,
 *                        fuzzyThreshold })                         → [{start,end,value}]
 *
 * @contract
 *   assertions:
 *     purity:          pure — no side effects, no external reads
 *     state_ownership: none
 *     external_io:     none
 */

/** Converts a glob pattern (* / ?) to a RegExp. * matches word chars; ? matches exactly one. */
export function globToRegex(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                           .replace(/\*/g, '\\w*')
                           .replace(/\?/g, '\\w');
    return new RegExp(escaped, caseSensitive ? '' : 'i');
}

/**
 * Parses a /pattern/flags string → RegExp, or treats a plain string as a case-insensitive
 * literal pattern. Returns null if the input is empty or produces an invalid RegExp.
 */
export function parseRegexPattern(str) {
    if (!str) return null;
    const m = str.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (m) {
        try { return new RegExp(m[1], m[2]); } catch { return null; }
    }
    try { return new RegExp(str, 'i'); } catch { return null; }
}

/** Matches text against one keyword (literal or glob). Returns the matched string or null. */
export function matchKeyword(text, kw, caseSensitive) {
    if (kw.includes('*') || kw.includes('?')) {
        const re = globToRegex(kw, caseSensitive);
        const m  = re.exec(text);
        return m ? m[0] : null;
    }
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, caseSensitive ? '' : 'i');
    return re.test(text) ? kw : null;
}

/** Tests text against a pattern string. Returns capture group 1, full match, or null. */
export function testRegex(text, patternStr) {
    const re = parseRegexPattern(patternStr);
    if (!re) return null;
    const m = re.exec(text);
    return m ? (m[1] ?? m[0]) : null;
}

/**
 * Jaro-Winkler similarity. Returns 0..1. Both strings should be pre-lowercased by the caller.
 * Prefix bonus (up to 4 chars) rewards strings that share a common start — ideal for proper names.
 */
export function jaroWinkler(a, b) {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (!la || !lb) return 0;
    const matchDist = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
    const aM = new Array(la).fill(false);
    const bM = new Array(lb).fill(false);
    let matches = 0;
    for (let i = 0; i < la; i++) {
        const lo = Math.max(0, i - matchDist);
        const hi = Math.min(i + matchDist + 1, lb);
        for (let j = lo; j < hi; j++) {
            if (bM[j] || a[i] !== b[j]) continue;
            aM[i] = bM[j] = true;
            matches++;
            break;
        }
    }
    if (!matches) return 0;
    let t = 0, k = 0;
    for (let i = 0; i < la; i++) {
        if (!aM[i]) continue;
        while (!bM[k]) k++;
        if (a[i] !== b[k]) t++;
        k++;
    }
    const jaro = (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
    let prefix = 0;
    const prefixLen = Math.min(4, la, lb);
    for (let i = 0; i < prefixLen; i++) {
        if (a[i] === b[i]) prefix++;
        else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Scans text for the best-matching word n-gram for a keyword using Jaro-Winkler.
 * Window width = word count of keyword. Returns {start, end, value} of the best
 * matching span at or above threshold, or null if nothing qualifies.
 * Both sides are lowercased internally; caseSensitivity is not applicable to fuzzy.
 */
export function fuzzyMatchText(text, keyword, threshold = 0.80) {
    const kwWords = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const n = kwWords.length;
    if (!n) return null;
    const kw = kwWords.join(' ');
    const words = [];
    const wordRe = /\S+/g;
    let m;
    while ((m = wordRe.exec(text)) !== null)
        words.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    if (words.length < n) return null;
    let best = null;
    for (let i = 0; i <= words.length - n; i++) {
        const window = words.slice(i, i + n);
        const score  = jaroWinkler(kw, window.map(w => w.word).join(' ').toLowerCase());
        if (score >= threshold && (!best || score > best.score))
            best = { start: window[0].start, end: window[n - 1].end, score,
                     value: text.slice(window[0].start, window[n - 1].end) };
    }
    return best ? { start: best.start, end: best.end, value: best.value } : null;
}

/**
 * Finds ALL match positions in text for UI highlighting (test drawer).
 * Returns [{start, end, value}] sorted by start, overlaps removed.
 *
 * Regex mode:   pass { useRegex:true, pattern }
 * Keyword mode: pass { resolvedKeywords:[...], caseSensitive }
 *   — resolvedKeywords must already be variable-expanded by the caller.
 * Fuzzy mode:   pass { useFuzzy:true, fuzzyKeywords:[...], fuzzyThreshold:0..1 }
 */
export function findAllMatches(text, { useRegex, pattern, resolvedKeywords, caseSensitive, useFuzzy, fuzzyKeywords, fuzzyThreshold }) {
    const spans = [];

    if (useFuzzy) {
        const thresh = fuzzyThreshold ?? 0.80;
        for (const kw of (fuzzyKeywords ?? [])) {
            const m = fuzzyMatchText(text, kw, thresh);
            if (m) spans.push(m);
        }
        spans.sort((a, b) => a.start - b.start);
        let cur = 0;
        return spans.filter(s => { if (s.start >= cur) { cur = s.end; return true; } return false; });
    }

    if (useRegex) {
        const re = parseRegexPattern(pattern ?? '');
        if (!re) return [];
        const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
        const gRe   = new RegExp(re.source, flags);
        let m;
        while ((m = gRe.exec(text)) !== null) {
            spans.push({ start: m.index, end: m.index + m[0].length, value: m[1] ?? m[0] });
            if (m[0].length === 0) gRe.lastIndex++;
        }
        return spans;
    }

    const cs = caseSensitive ?? false;
    for (const kw of (resolvedKeywords ?? [])) {
        let re;
        if (kw.includes('*') || kw.includes('?')) {
            const esc = kw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\w*').replace(/\?/g, '\\w');
            re = new RegExp(esc, cs ? 'g' : 'gi');
        } else {
            re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, cs ? 'g' : 'gi');
        }
        let m;
        while ((m = re.exec(text)) !== null) {
            spans.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
            if (m[0].length === 0) re.lastIndex++;
        }
    }

    spans.sort((a, b) => a.start - b.start);
    let cursor = 0;
    return spans.filter(s => { if (s.start >= cursor) { cursor = s.end; return true; } return false; });
}
