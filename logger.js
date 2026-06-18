/**
 * @file st-extensions/SillyTavern-Triggeryze/logger.js
 * @stamp {"utc":"2026-06-17T00:00:00.000Z"}
 * @architectural-role IO — centralised logging utility
 * @description
 * All TRG log output flows through this module so the prefix is consistent and
 * verbose gating lives in one place. Files that need logging import from here
 * rather than calling console directly.
 *
 * @api-declaration
 * trgLog(tag, ...args)   — verbose-gated (settings.verbose); outputs [TRG] tag
 * trgDev(debug, ...args) — rule.devMode-gated; outputs [TRG:dev] ...args
 * trgWarn(...args)       — always on; outputs [TRG] ...args
 * trgError(...args)      — always on; outputs [TRG] ...args
 * trgInfo(...args)       — always on; outputs [TRG] ...args
 * trgPerf(msg)           — verbose-gated; outputs [TRG:PERF] msg
 *
 * @contract
 *   assertions:
 *     purity:          impure — reads getSettings()?.verbose at call time
 *     state_ownership: none
 *     external_io:     console
 */

import { getSettings } from './settings/storage.js';

export const trgLog   = (tag, ...args) => { if (getSettings()?.verbose) console.log(`[TRG] ${tag}`, ...args); };
export const trgDev   = (debug, ...args) => { if (debug) console.log('[TRG:dev]', ...args); };
export const trgWarn  = (...args) => console.warn('[TRG]', ...args);
export const trgError = (...args) => console.error('[TRG]', ...args);
export const trgInfo  = (...args) => console.info('[TRG]', ...args);
export const trgPerf  = (msg) => { if (getSettings()?.verbose) console.info(`[TRG:PERF] ${msg}`); };
