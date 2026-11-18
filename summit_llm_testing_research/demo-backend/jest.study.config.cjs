const arm = process.env.EXPERIMENT_ARM || 'baseline';
const trial = (process.env.EXPERIMENT_TRIAL || '01').padStart(2, '0');
if (!['baseline', 'guided'].includes(arm) || !/^\d{2,}$/.test(trial)) {
  throw new Error('Set valid EXPERIMENT_ARM=baseline|guided and EXPERIMENT_TRIAL=01,02,...');
}
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [`<rootDir>/src/**/*.${arm}.r${trial}.test.ts`],
  clearMocks: true,
  collectCoverageFrom: [process.env.MUTATE_TARGET || 'src/canEditPost.ts'],
  coverageReporters: ['text', 'json-summary'],
  coverageDirectory: `reports/coverage/${arm}/trial${trial}`
};
