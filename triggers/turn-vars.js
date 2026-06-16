/**
 * @file triggers/turn-vars.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role IO — turn-level ephemeral variable store
 * @description
 * Owns the per-turn variable map shared across all rules within a single generation.
 * Cleared at GENERATION_STARTED; readable and writable during stream and postMessage stages.
 * Does not persist across turns — callers that need durable state must use ST variables or lorebooks.
 *
 * @api-declaration
 * setTurnVar(name, value)   — writes a value into the current turn's store
 * getTurnVar(name)          → any | undefined
 * clearTurnVars()           — resets the store; call on GENERATION_STARTED
 * getTurnVarsSnapshot()     → {[name]: any}  plain object copy for read-only consumers
 *
 * @contract
 *   assertions:
 *     purity:          no external IO; pure in-memory map
 *     state_ownership: [_turnVars]
 *     external_io:     none
 */

const _turnVars = new Map();

export function setTurnVar(name, value)  { _turnVars.set(name, value); }
export function getTurnVar(name)         { return _turnVars.get(name); }
export function clearTurnVars()          { _turnVars.clear(); }
export function getTurnVarsSnapshot()    { return Object.fromEntries(_turnVars); }
