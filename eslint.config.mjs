import js from '@eslint/js';
import n8nCommunityNodes from '@n8n/eslint-plugin-community-nodes';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'scripts/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				project: ['./tsconfig.test.json'],
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ prefer: 'type-imports', fixStyle: 'inline-type-imports' },
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			// n8n node classes declare public fields without modifiers by convention.
			'@typescript-eslint/no-explicit-any': 'error',
			eqeqeq: ['error', 'smart'],
			'no-console': ['error', { allow: ['warn', 'error'] }],
		},
	},
	// The community-nodes rules are what n8n Cloud verification actually checks.
	n8nCommunityNodes.configs.recommended,
	{
		files: ['tests/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
);
