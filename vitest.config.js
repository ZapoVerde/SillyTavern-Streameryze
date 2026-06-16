import { defineConfig } from 'vitest/config';
import { resolve }      from 'path';

const __dirname = new URL('.', import.meta.url).pathname;

// Alias any import whose path ends in scripts/world-info.js or scripts/variables.js
// to the in-tree stubs, regardless of how many ../ prefixes the import uses.
// This is required because triggers/ submodules sit one level deeper than the project
// root and therefore use 5-up relative paths while callers at the root use 4-up paths.
// Without aliases, the two depths would resolve to different (non-existent) files and
// Vitest would see them as separate module instances — breaking vi.mocked() control.
export default defineConfig({
    test: {
        environment: 'node',
    },
    resolve: {
        alias: [
            {
                find: /.*\/scripts\/world-info\.js$/,
                replacement: resolve(__dirname, 'tests/__mocks__/world-info.js'),
            },
            {
                find: /.*\/scripts\/variables\.js$/,
                replacement: resolve(__dirname, 'tests/__mocks__/variables.js'),
            },
        ],
    },
});
