/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/transforms.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
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

export const TRANSFORM_PREFIXES = ['trim:', 'upper:', 'lower:', 'lines:', 'words:', 'default:'];

export function resolveTransforms(template) {
    if (!template) return template;

    // {{trim: val}} / {{upper: val}} / {{lower: val}}
    template = template.replace(/\{\{(trim|upper|lower):\s*([\s\S]*?)\}\}/g, (_, fn, val) => {
        if (fn === 'trim')  return val.trim();
        if (fn === 'upper') return val.toUpperCase();
        return val.toLowerCase();
    });

    // {{lines: N: val}} — first N lines; {{words: N: val}} — first N whitespace-separated tokens
    template = template.replace(/\{\{(lines|words):\s*(\d+):\s*([\s\S]*?)\}\}/g, (_, fn, n, val) => {
        const count = Math.max(1, parseInt(n, 10));
        if (fn === 'lines') return val.split('\n').slice(0, count).join('\n');
        return val.trim().split(/\s+/).slice(0, count).join(' ');
    });

    // {{default: fallback: val}} — return val if non-empty after trim, otherwise fallback.
    // Fallback may not contain a colon. val is typically a resolved {{varName}} reference.
    template = template.replace(/\{\{default:\s*(.*?):\s*([\s\S]*?)\}\}/g, (_, fallback, val) =>
        val.trim() ? val : fallback,
    );

    return template;
}
