const arm = process.env.EXPERIMENT_ARM || 'baseline';
const trial = (process.env.EXPERIMENT_TRIAL || '01').padStart(2, '0');
if (!['baseline', 'guided'].includes(arm) || !/^\d{2,}$/.test(trial)) {
  throw new Error('Invalid EXPERIMENT_ARM or EXPERIMENT_TRIAL');
}
export default {
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.study.config.cjs',
    enableFindRelatedTests: false
  },
  mutate: [process.env.MUTATE_TARGET || 'src/canEditPost.ts'],
  coverageAnalysis: 'off',
  concurrency: 2,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: `reports/${arm}/trial${trial}/mutation.html` },
  jsonReporter: { fileName: `reports/${arm}/trial${trial}/mutation.json` }
};
