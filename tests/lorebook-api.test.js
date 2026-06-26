import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: vi.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF': 'token' })),
    eventSource:       { emit: mockEmit },
    event_types:       { WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
}));

// worldInfoCache comes from the stub via the vitest resolve alias.
// The alias maps any path ending in /scripts/world-info.js to the shared
// stub module, so both the code under test and this import share the same instance.
import { worldInfoCache } from '../../../../scripts/world-info.js';
import { lbGetLorebook, lbSaveLorebook } from '../lorebookApi.js';

function mockFetch(status, body) {
    global.fetch = vi.fn(async () => ({
        ok:   status >= 200 && status < 300,
        status,
        json: async () => body,
    }));
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// lbGetLorebook
// ---------------------------------------------------------------------------

describe('lbGetLorebook', () => {
    it('calls /api/worldinfo/get with POST and the lorebook name', async () => {
        mockFetch(200, { entries: {} });
        await lbGetLorebook('MyBook');
        expect(fetch).toHaveBeenCalledOnce();
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toBe('/api/worldinfo/get');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body)).toEqual({ name: 'MyBook' });
    });

    it('returns the parsed JSON body on success', async () => {
        const data = { entries: { 0: { comment: 'Entry', content: 'text' } } };
        mockFetch(200, data);
        const result = await lbGetLorebook('MyBook');
        expect(result).toEqual(data);
    });

    it('includes the headers from getRequestHeaders', async () => {
        mockFetch(200, { entries: {} });
        await lbGetLorebook('MyBook');
        const opts = fetch.mock.calls[0][1];
        expect(opts.headers['X-CSRF']).toBe('token');
    });

    it('throws on a non-OK response', async () => {
        mockFetch(404, {});
        await expect(lbGetLorebook('Missing')).rejects.toThrow('404');
    });

    it('throws on a 500 server error', async () => {
        mockFetch(500, {});
        await expect(lbGetLorebook('Book')).rejects.toThrow('500');
    });
});

// ---------------------------------------------------------------------------
// lbSaveLorebook
// ---------------------------------------------------------------------------

describe('lbSaveLorebook', () => {
    it('calls /api/worldinfo/edit with the lorebook name and data', async () => {
        mockFetch(200, {});
        const data = { entries: { 0: { comment: 'E', content: 'c' } } };
        await lbSaveLorebook('MyBook', data);
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toBe('/api/worldinfo/edit');
        expect(opts.method).toBe('POST');
        const body = JSON.parse(opts.body);
        expect(body.name).toBe('MyBook');
        expect(body.data).toEqual(data);
    });

    it('updates worldInfoCache with the correct name and data', async () => {
        mockFetch(200, {});
        const data = { entries: { 0: { comment: 'E', content: 'c' } } };
        await lbSaveLorebook('MyBook', data);
        expect(worldInfoCache.set).toHaveBeenCalledOnce();
        expect(worldInfoCache.set).toHaveBeenCalledWith('MyBook', data);
    });

    it('emits WORLDINFO_UPDATED after a successful save', async () => {
        mockFetch(200, {});
        await lbSaveLorebook('MyBook', { entries: {} });
        expect(mockEmit).toHaveBeenCalledWith('WORLDINFO_UPDATED', 'MyBook', { entries: {} });
    });

    it('updates cache before emitting WORLDINFO_UPDATED', async () => {
        mockFetch(200, {});
        await lbSaveLorebook('MyBook', { entries: {} });
        const cacheOrder = worldInfoCache.set.mock.invocationCallOrder[0];
        const emitOrder  = mockEmit.mock.invocationCallOrder[0];
        expect(cacheOrder).toBeLessThan(emitOrder);
    });

    it('throws on a non-OK response and does not update cache or emit', async () => {
        mockFetch(403, {});
        await expect(lbSaveLorebook('Locked', {})).rejects.toThrow('403');
        expect(worldInfoCache.set).not.toHaveBeenCalled();
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('throws on 500 and does not update cache or emit', async () => {
        mockFetch(500, {});
        await expect(lbSaveLorebook('Book', {})).rejects.toThrow('500');
        expect(worldInfoCache.set).not.toHaveBeenCalled();
        expect(mockEmit).not.toHaveBeenCalled();
    });
});
