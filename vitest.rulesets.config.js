import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// Separate config for `npm run test:rulesets` only. Deliberately NOT merged into the
// default test.include in vitest.config.js — docs/ruleset-tests/*.check.js files check
// example/doc rulesets (which can change independently of engine code) and must never
// gate the default `npm test` / `vitest run`.
export default mergeConfig(baseConfig, defineConfig({
    test: {
        include: ['docs/ruleset-tests/**/*.check.js'],
        coverage: { enabled: false },
    },
}));
