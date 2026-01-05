// Main exports for programmatic usage

// Screenshot capture
export { GalaxyClient } from './galaxy/client';
export { ScreenshotRunner } from './capture/screenshot';
export { annotateImage } from './capture/annotate';
export * from './config/types';

// Tutorial generation
export { TutorialGenerator } from './tutorial/generator';
export { AIGenerator } from './tutorial/ai-generator';
export { convertRecording, RecordingConverter } from './tutorial/recording-converter';
export * from './tutorial/types';
