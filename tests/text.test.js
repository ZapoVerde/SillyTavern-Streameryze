import { describe, it, expect } from 'vitest';

// text.js defines esc() with a jQuery body but never CALLS it at load time,
// so the module loads cleanly in Node.js. We skip esc() tests here.
import {
    runQueued,
    buildHistoryText,
    extractParagraph,
    collectUniqueParagraphs,
} from '../actions/text.js';

// ---------------------------------------------------------------------------
// runQueued
// ---------------------------------------------------------------------------

describe('runQueued', () => {
    it('resolves immediately with an empty array for no tasks', async () => {
        expect(await runQueued([])).toEqual([]);
    });

    it('resolves a single task with its return value', async () => {
        const results = await runQueued([async () => 'hello']);
        expect(results).toEqual(['hello']);
    });

    it('preserves result order regardless of completion order', async () => {
        // Task 0 finishes after task 1 but should still appear first.
        let releaseFirst;
        const held = new Promise(r => { releaseFirst = r; });
        const tasks = [
            async () => { await held; return 'slow'; },
            async () => 'fast',
        ];
        const promise = runQueued(tasks, 2); // run both in parallel
        releaseFirst();
        expect(await promise).toEqual(['slow', 'fast']);
    });

    it('treats a rejected task as null and continues to subsequent tasks', async () => {
        const tasks = [
            async () => 'ok',
            async () => { throw new Error('boom'); },
            async () => 'also ok',
        ];
        const results = await runQueued(tasks, 1);
        expect(results[0]).toBe('ok');
        expect(results[1]).toBeNull();
        expect(results[2]).toBe('also ok');
    });

    it('runs tasks serially with concurrency=1 (default)', async () => {
        const order = [];
        const tasks = [
            async () => { order.push(1); return 'a'; },
            async () => { order.push(2); return 'b'; },
            async () => { order.push(3); return 'c'; },
        ];
        const results = await runQueued(tasks, 1);
        expect(results).toEqual(['a', 'b', 'c']);
        expect(order).toEqual([1, 2, 3]);
    });

    it('caps in-flight tasks at the concurrency limit', async () => {
        let inFlight = 0;
        let peak = 0;
        const make = () => async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await Promise.resolve(); // yield one microtask
            inFlight--;
            return null;
        };
        await runQueued(Array.from({ length: 6 }, make), 2);
        expect(peak).toBeLessThanOrEqual(2);
    });

    it('a task that returns undefined is stored as null', async () => {
        const results = await runQueued([async () => undefined]);
        expect(results[0]).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// buildHistoryText
// ---------------------------------------------------------------------------

describe('buildHistoryText', () => {
    it('returns empty string when chat is empty', () => {
        expect(buildHistoryText([], 0, 2)).toBe('');
    });

    it('returns empty string when numPairs is 0', () => {
        const chat = [{ name: 'User', mes: 'hello' }];
        expect(buildHistoryText(chat, 1, 0)).toBe('');
    });

    it('returns empty string when numPairs is negative', () => {
        const chat = [{ name: 'User', mes: 'hello' }];
        expect(buildHistoryText(chat, 1, -1)).toBe('');
    });

    it('formats a single turn as "Name: message"', () => {
        const chat = [
            { name: 'User', mes: 'hello' },
            { name: 'Bot',  mes: 'hi'    },
        ];
        // beforeIndex=2 includes both messages; numPairs=1 → 2 messages
        expect(buildHistoryText(chat, 2, 1)).toBe('User: hello\n\nBot: hi');
    });

    it('joins multiple messages with double newlines', () => {
        const chat = [
            { name: 'User', mes: 'one'   },
            { name: 'Bot',  mes: 'two'   },
            { name: 'User', mes: 'three' },
            { name: 'Bot',  mes: 'four'  },
        ];
        const result = buildHistoryText(chat, 4, 2);
        expect(result).toBe('User: one\n\nBot: two\n\nUser: three\n\nBot: four');
    });

    it('does not include messages at or after beforeIndex', () => {
        const chat = [
            { name: 'User', mes: 'included' },
            { name: 'Bot',  mes: 'excluded' },
        ];
        expect(buildHistoryText(chat, 1, 2)).toBe('User: included');
    });

    it('takes the last N*2 messages before beforeIndex when there are more', () => {
        const chat = [
            { name: 'A', mes: '1' },
            { name: 'B', mes: '2' },
            { name: 'C', mes: '3' },
            { name: 'D', mes: '4' },
            { name: 'E', mes: '5' },
        ];
        // beforeIndex=5, numPairs=1 → takes last 2: indices 3 and 4
        expect(buildHistoryText(chat, 5, 1)).toBe('D: 4\n\nE: 5');
    });

    it('uses "Unknown" when name is missing', () => {
        const chat = [{ mes: 'hello' }];
        expect(buildHistoryText(chat, 1, 1)).toBe('Unknown: hello');
    });

    it('uses empty string when mes is missing', () => {
        const chat = [{ name: 'User' }];
        expect(buildHistoryText(chat, 1, 1)).toBe('User: ');
    });
});

// ---------------------------------------------------------------------------
// extractParagraph
// ---------------------------------------------------------------------------

describe('extractParagraph', () => {
    it('single-line text: returns the whole string', () => {
        const text = 'hello world';
        expect(extractParagraph(text, 0)).toEqual({ text: 'hello world', start: 0, end: 11 });
    });

    it('match in the first paragraph of a multi-line text', () => {
        const text = 'first line\nsecond line\nthird line';
        expect(extractParagraph(text, 3)).toEqual({ text: 'first line', start: 0, end: 10 });
    });

    it('match in a middle paragraph', () => {
        const text = 'first\nsecond\nthird';
        // 'second' starts at index 6
        expect(extractParagraph(text, 6)).toEqual({ text: 'second', start: 6, end: 12 });
    });

    it('match in the last paragraph (no trailing newline)', () => {
        const text = 'first\nsecond\nthird';
        // 'third' starts at index 13
        expect(extractParagraph(text, 13)).toEqual({ text: 'third', start: 13, end: 18 });
    });

    it('matchIndex exactly at the start of a paragraph', () => {
        const text = 'line1\nline2';
        expect(extractParagraph(text, 6)).toEqual({ text: 'line2', start: 6, end: 11 });
    });

    it('returns correct start and end for paragraph extraction', () => {
        const text = 'alpha\nbeta\ngamma';
        const { text: para, start, end } = extractParagraph(text, 8); // inside 'beta'
        expect(para).toBe('beta');
        expect(text.slice(start, end)).toBe('beta');
    });
});

// ---------------------------------------------------------------------------
// collectUniqueParagraphs
// ---------------------------------------------------------------------------

describe('collectUniqueParagraphs', () => {
    it('returns empty array when regex finds no matches', () => {
        expect(collectUniqueParagraphs('hello world', /dragon/gi)).toEqual([]);
    });

    it('returns a single paragraph for one match', () => {
        const result = collectUniqueParagraphs('A dragon appeared.', /dragon/gi);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('A dragon appeared.');
    });

    it('deduplicates multiple matches within the same paragraph', () => {
        const text = 'dragon and dragon';
        const result = collectUniqueParagraphs(text, /dragon/gi);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('dragon and dragon');
    });

    it('returns multiple paragraphs when matches span different lines', () => {
        const text = 'A dragon roars.\nA knight rides.\nAnother dragon flies.';
        const result = collectUniqueParagraphs(text, /dragon/gi);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('A dragon roars.');
        expect(result[1].text).toBe('Another dragon flies.');
    });

    it('returns paragraphs in document order (ascending start)', () => {
        const text = 'line one dragon\nline two dragon\nline three';
        const result = collectUniqueParagraphs(text, /dragon/gi);
        expect(result[0].start).toBeLessThan(result[1].start);
    });

    it('returns start and end that correctly slice the source text', () => {
        const text = 'before\ndragons here\nafter';
        const [para] = collectUniqueParagraphs(text, /dragon/gi);
        expect(text.slice(para.start, para.end)).toBe('dragons here');
    });

    it('resets regex lastIndex between calls (safe to reuse the regex)', () => {
        const re = /x/gi;
        re.lastIndex = 99; // deliberately corrupt lastIndex
        const result = collectUniqueParagraphs('x marks the spot', re);
        expect(result).toHaveLength(1);
    });
});
