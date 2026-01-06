// Main exports for programmatic usage

// Galaxy clients
export { GalaxyClient } from './galaxy/client';
export { GalaxyHistoryClient } from './galaxy/history-client';
export { JobParamsClient } from './galaxy/job-params';
export { FormMapper } from './galaxy/form-mapper';

// Tutorial generation
export { TutorialGenerator } from './tutorial/generator';
export { HistoryConverter } from './tutorial/history-converter';
export { AIGenerator } from './tutorial/ai-generator';
export * from './tutorial/types';

// Image annotation
export { annotateImage } from './capture/annotate';
