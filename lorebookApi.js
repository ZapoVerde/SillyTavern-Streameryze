/**
 * @file st-extensions/SillyTavern-Triggeryze/lorebookApi.js
 * @architectural-role IO Wrapper
 * @description
 * Thin HTTP wrappers around ST's worldinfo endpoints.
 * No business logic — each function maps to one server call.
 *
 * @api-declaration
 * lbGetLorebook(name)        → Promise<{ entries: {} }>
 * lbSaveLorebook(name, data) → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:      mutates
 *     state_ownership: [none]
 *     external_io: [/api/worldinfo/get, /api/worldinfo/edit]
 */

import { getRequestHeaders, eventSource, event_types } from '../../../../script.js';

export async function lbGetLorebook(name) {
    const res = await fetch('/api/worldinfo/get', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Lorebook fetch failed (HTTP ${res.status})`);
    return res.json();
}

export async function lbSaveLorebook(name, data) {
    const res = await fetch('/api/worldinfo/edit', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(`Lorebook save failed (HTTP ${res.status})`);
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}
