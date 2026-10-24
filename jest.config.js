/** @type {import('jest').Config} */
const tsJest = ['ts-jest', {}];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform: { '^.+\\.ts$': tsJest },
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/simulator/**/*.spec.ts'],
    },
    {
      displayName: 'e2e',
      testEnvironment: 'node',
      transform: { '^.+\\.ts$': tsJest },
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
    },
  ],
};
