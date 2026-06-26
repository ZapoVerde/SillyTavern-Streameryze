// Stub for scripts/world-info.js — aliased by vitest.config.js resolve.alias.
// All relative-depth imports of world-info.js resolve here, giving vi.mocked()
// a single module instance to control regardless of caller depth.
import { vi } from 'vitest';

export async function getSortedEntries() { return []; }
export async function loadWorldInfo()    { return null; }
export function parseRegexFromString()   { return null; }
export const world_info_case_sensitive = false;
export const world_names               = [];
export const worldInfoCache            = { set: vi.fn(), get: vi.fn(), has: vi.fn(), delete: vi.fn() };
