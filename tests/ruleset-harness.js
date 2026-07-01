/**
 * @file st-extensions/SillyTavern-Triggeryze/tests/ruleset-harness.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role IO — reusable turn-simulation infrastructure for exercising a full ruleset JSON
 * @description
 * Drives an example/doc ruleset (docs/examples/*.json) through the real engine —
 * evaluateTriggers, executeActions, rule-registry's pub/sub dispatch — with only the
 * SillyTavern boundary faked. Built for checking documentation content, which can change
 * independently of engine code; engine regressions belong in tests/*.test.js against small
 * synthetic rules instead, not here.
 *
 * vi.mock() calls cannot live here: Vitest hoists them per-file at transform time, so each
 * caller must declare its own ST-boundary mocks (script.js, scripts/world-info.js,
 * scripts/variables.js, actions/index.js, etc.) before importing from this module. This file
 * only offers the parts that don't need hoisting: the in-memory lorebook store, the stCtx
 * factory, and turn simulation sequencing.
 *
 * @api-declaration
 * makeLorebookStore()                                  — Map-backed store shared by lbGetLorebook/
 *                                                         lbSaveLorebook/loadWorldInfo mocks
 * makeStCtx(mes, opts)                                 — minimal ST execution context stub
 * loadRulesetFromFile(absPath, makeId)                 — reads and imports a v2 ruleset JSON file
 * simulateTurn({streamText, messageText, msgId, settleMs}) — runs the stream → message →
 *                                                         MESSAGE_RECEIVED sequence and waits
 *                                                         for async actions to settle
 *
 * @contract
 *   assertions:
 *     purity:          none — simulateTurn drives the real turn-state.js singletons
 *     state_ownership: none of its own; operates on whatever turn-state/lorebook state the caller wires up
 *     external_io:     fs (loadRulesetFromFile only)
 */

import fs from 'node:fs';
import { vi } from 'vitest';
import { updateStreamText, updateMessageText, setFlag } from '../engine/turn-state.js';
import { importRuleset, stripJsonc } from '../settings/format.js';

export function makeLorebookStore() {
    return new Map(); // world name -> { entries: {...} }
}

export function makeStCtx(mes, opts = {}) {
    return {
        chat: [{ mes, name: 'Bot', is_user: false, is_system: false }],
        chatId: opts.chatId ?? 'test-chat',
        saveChat: vi.fn(async () => {}),
        executeSlashCommandsWithOptions:
            opts.executeSlashCommandsWithOptions ?? vi.fn(async () => ({ pipe: '' })),
    };
}

export function loadRulesetFromFile(absPath, makeId) {
    const raw = JSON.parse(stripJsonc(fs.readFileSync(absPath, 'utf8')));
    const warnings = [];
    const ruleset = importRuleset(raw, makeId, warnings);
    return { ruleset, warnings };
}

/**
 * Runs one turn: streams the given text (fires stream-tier rules), commits it as the
 * final message, then raises MESSAGE_RECEIVED (fires postMessage-tier rules) — mirroring
 * engine.js's onStreamToken → onMessageReceived sequence closely enough for rule-registry's
 * reactive dispatch to behave the same way it would in the real extension. Waits after each
 * stage so same-tick microtask chains (and any deliberately-added setTimeout latency in a
 * caller's mocks) settle before returning.
 */
export async function simulateTurn({ streamText, messageText, msgId = 0, settleMs = 50 }) {
    updateStreamText(streamText ?? messageText, msgId);
    await new Promise(r => setTimeout(r, 0));

    updateMessageText(messageText, msgId);
    setFlag('MESSAGE_RECEIVED');

    await new Promise(r => setTimeout(r, settleMs));
}
