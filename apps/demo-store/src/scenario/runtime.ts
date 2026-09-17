import { createSimulation } from '@alive-internal/core';
import { createProductLaunchScenario } from './productLaunch.js';

export const simulation = createSimulation({
  scenario: createProductLaunchScenario(),
  seed: 'northstar-launch-demo-v1',
  checkpointEvery: 4,
});
