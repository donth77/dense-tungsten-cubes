import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The architectural rules from 08 §5 are lint-enforced here, not just documented.
 * They use the core `no-restricted-imports` rule deliberately: it matches on the
 * import specifier string, so it needs no module resolver and cannot silently stop
 * working when a resolver config drifts. The firewall is too important to be fragile.
 *
 * Dependency direction (08 §5) — lower layers never import upper ones:
 *   types.ts <- data/ <- core/ <- interaction/, fx/ <- labs/ <- ui/ <- app.ts <- main.ts
 */

/** Layers, ordered lowest-first. A layer may not import from anything after it. */
const LAYERS = ['data', 'core', 'interaction', 'fx', 'labs', 'ui'];

/** @returns the specifier patterns a file in `layer` is forbidden from importing. */
const above = (layer) =>
  LAYERS.slice(LAYERS.indexOf(layer) + 1)
    .flatMap((l) => [`**/${l}/*`, `**/${l}/**/*`])
    .concat('**/app', '**/app.ts', '**/main', '**/main.ts');

const layerRule = (layer) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: above(layer),
            message: `src/${layer}/ may not import from a higher layer (08 §5: ${LAYERS.join(' <- ')}).`,
          },
        ],
      },
    ],
  },
});

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'docs/', 'assets-lib/'] },

  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Units live in names (08 §5.5); an unused import is usually a half-finished refactor.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // 08 §5.6: no default exports.
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: '08 §5.6: no default exports.' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      /*
       * OFF, deliberately, because it fights `noUncheckedIndexedAccess: true` — which is
       * on the tsconfig strictness floor (08 §3) and is the stricter of the two.
       *
       * That flag makes every `arr[i]` a `T | undefined`, so a numeric loop over an array
       * whose bounds are right there in the `for` header still has to acknowledge a case
       * that cannot happen. Keeping both means either weakening the type-level guarantee
       * or writing defensive branches inside a 60 Hz loop. The type checker already
       * forces the decision at every index; this rule only punishes writing it down.
       *
       * Handle lookups that genuinely could miss don't use `!` — they go through
       * PhysicsWorld#must(), which throws a message that names the bad handle.
       */
      '@typescript-eslint/no-non-null-assertion': 'off',

      // A private constructor with no body is the idiomatic "use the async factory"
      // marker (PhysicsWorld.create must await the wasm).
      '@typescript-eslint/no-empty-function': ['error', { allow: ['private-constructors'] }],
    },
  },

  // console.table is the right tool for the jitter matrix, and debug.ts is the one
  // module that exists to print to a console.
  {
    files: ['src/debug.ts', 'src/calibrate.ts'],
    rules: { 'no-console': 'off' },
  },

  // ---- The Rapier firewall (08 §5.1) --------------------------------------
  // core/physics.ts is the only file allowed to know Rapier exists. This is the
  // engine-swap seam and the reason unit tests never need wasm.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/physics.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@dimforge/rapier3d-compat',
              message:
                'The Rapier firewall (08 §5.1): only src/core/physics.ts may import Rapier. ' +
                'Add what you need to the PhysicsWorld surface instead.',
            },
          ],
        },
      ],
    },
  },

  // ---- three.js confinement (08 §5.2) -------------------------------------
  // ui/ and data/ stay pure DOM/data so they are trivially testable without a canvas.
  {
    files: ['src/ui/**/*.ts', 'src/data/**/*.ts', 'src/types.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'three',
              message:
                'three.js confinement (08 §5.2): forbidden in ui/, data/ and types.ts. ' +
                'Those layers stay pure DOM/data.',
            },
          ],
          patterns: [{ group: ['three/*'], message: 'three.js confinement (08 §5.2).' }],
        },
      ],
    },
  },

  // ---- Layer direction (08 §5) --------------------------------------------
  ...LAYERS.map(layerRule),

  // types.ts imports nothing at all.
  {
    files: ['src/types.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['*', '**/*'], message: '08 §4: types.ts imports nothing. It is the root.' },
          ],
        },
      ],
    },
  },

  // Tests may reach anywhere and say `any` where a fixture needs it.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // Config files run in Node, not the browser.
  {
    files: ['*.config.ts', '*.config.js'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
);
