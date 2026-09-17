import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.verify/**'] },

  {
    files: ['apps/**/*.{ts,tsx}'],
    languageOptions: { parser: tsparser, parserOptions: { ecmaFeatures: { jsx: true } }, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['packages/**/src/**/*.ts'],
    languageOptions: { parser: tsparser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'INV-7: no wall-clock reads in the kernel.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'INV-35: use ctx.random.' },
        { object: 'Date', property: 'now', message: 'INV-7: no wall-clock reads.' },
        { object: 'performance', property: 'now', message: 'INV-7: no wall-clock reads.' },
        { object: 'crypto', property: 'randomUUID', message: 'INV-54: no UUIDs.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: 'INV-7: no wall-clock reads.' },
      ],
    },
  },
];
