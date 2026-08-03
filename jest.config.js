/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests'],
	testMatch: ['**/*.test.ts'],
	clearMocks: true,
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
	},
	collectCoverageFrom: ['credentials/**/*.ts', 'nodes/**/*.ts'],
	coverageDirectory: 'coverage',
};
