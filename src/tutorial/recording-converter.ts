import * as fs from 'fs';
import {
  TutorialConfig,
  TutorialMetadata,
  Section,
  HandsOnStep,
  ToolStep,
  ScreenshotStep,
} from './types';

// Chrome DevTools Recorder JSON format types
interface DevToolsRecording {
  title: string;
  steps: DevToolsStep[];
}

interface DevToolsStep {
  type: string;
  target?: string;
  selectors?: string[][];
  url?: string;
  value?: string;
  key?: string;
  offsetX?: number;
  offsetY?: number;
  duration?: number;
  button?: string;
}

interface ConversionOptions {
  galaxyUrl: string;
  metadata: Partial<TutorialMetadata>;
  outputDir: string;
  imagesDir: string;
  addScreenshots?: boolean;
  sectionMarkers?: { stepIndex: number; title: string }[];
}

export class RecordingConverter {
  private recording: DevToolsRecording;
  private options: ConversionOptions;

  constructor(recordingPath: string, options: ConversionOptions) {
    const content = fs.readFileSync(recordingPath, 'utf-8');
    this.recording = JSON.parse(content);
    this.options = options;
  }

  convert(): TutorialConfig {
    const sections = this.groupStepsIntoSections();

    const config: TutorialConfig = {
      metadata: this.buildMetadata(),
      galaxy: {
        url: this.options.galaxyUrl,
      },
      output: {
        tutorial_dir: this.options.outputDir,
        images_dir: this.options.imagesDir,
      },
      sections,
    };

    return config;
  }

  private buildMetadata(): TutorialMetadata {
    return {
      title: this.options.metadata.title || this.recording.title || 'New Tutorial',
      questions: this.options.metadata.questions || ['What will you learn in this tutorial?'],
      objectives: this.options.metadata.objectives || ['Learn to use Galaxy tools'],
      contributions: this.options.metadata.contributions || {
        authorship: ['your-github-username'],
      },
      level: this.options.metadata.level || 'Introductory',
      ...this.options.metadata,
    };
  }

  private groupStepsIntoSections(): Section[] {
    const sections: Section[] = [];
    let currentSection: Section | null = null;
    let currentSteps: HandsOnStep[] = [];
    let screenshotCounter = 1;

    for (let i = 0; i < this.recording.steps.length; i++) {
      const step = this.recording.steps[i];

      // Check for section markers
      const marker = this.options.sectionMarkers?.find((m) => m.stepIndex === i);
      if (marker || !currentSection) {
        // Save previous section
        if (currentSection && currentSteps.length > 0) {
          currentSection.steps = currentSteps;
          sections.push(currentSection);
        }

        // Start new section
        currentSection = {
          id: this.slugify(marker?.title || `section-${sections.length + 1}`),
          title: marker?.title || `Step ${sections.length + 1}`,
          type: 'hands_on',
        };
        currentSteps = [];
      }

      // Convert step
      const handsOnStep = this.convertStep(step, screenshotCounter);
      if (handsOnStep) {
        currentSteps.push(handsOnStep);

        // Add screenshot after significant actions
        if (this.options.addScreenshots && this.isSignificantAction(step)) {
          currentSteps.push({
            type: 'screenshot',
            screenshot: {
              filename: `step_${screenshotCounter}.png`,
              caption: `Screenshot after ${this.describeStep(step)}`,
            },
          });
          screenshotCounter++;
        }
      }
    }

    // Save last section
    if (currentSection && currentSteps.length > 0) {
      currentSection.steps = currentSteps;
      sections.push(currentSection);
    }

    return sections;
  }

  private convertStep(step: DevToolsStep, screenshotNum: number): HandsOnStep | null {
    switch (step.type) {
      case 'navigate':
        if (step.url?.includes('tool_id=')) {
          // This is navigating to a tool
          const toolId = this.extractToolId(step.url);
          if (toolId) {
            return {
              type: 'tool_run',
              tool: {
                tool_id: toolId,
                name: this.toolIdToName(toolId),
                params: [], // Will be filled by subsequent click/change events
              },
            };
          }
        }
        return {
          type: 'instruction',
          text: `Navigate to: ${step.url}`,
        };

      case 'click':
        const selector = this.getBestSelector(step.selectors);
        if (this.isToolParameter(selector)) {
          return null; // Will be handled as part of tool configuration
        }
        return {
          type: 'instruction',
          text: `Click on ${this.describeSelector(selector)}`,
        };

      case 'change':
        return {
          type: 'instruction',
          text: `Set value to: \`${step.value}\``,
        };

      case 'keyDown':
        if (step.key === 'Enter') {
          return {
            type: 'instruction',
            text: 'Press Enter to confirm',
          };
        }
        return null;

      case 'scroll':
        return null; // Usually not relevant for tutorials

      case 'waitForElement':
        return {
          type: 'instruction',
          text: `Wait for element to appear`,
        };

      default:
        return null;
    }
  }

  private isSignificantAction(step: DevToolsStep): boolean {
    // Add screenshots after navigation, form submissions, etc.
    return (
      step.type === 'navigate' ||
      (step.type === 'click' && this.isButtonClick(step)) ||
      step.type === 'submit'
    );
  }

  private isButtonClick(step: DevToolsStep): boolean {
    const selector = this.getBestSelector(step.selectors);
    return (
      selector.includes('button') ||
      selector.includes('btn') ||
      selector.includes('submit') ||
      selector.includes('[type="submit"]')
    );
  }

  private isToolParameter(selector: string): boolean {
    return (
      selector.includes('data-label') ||
      selector.includes('.tool-form') ||
      selector.includes('gx-form')
    );
  }

  private getBestSelector(selectors?: string[][]): string {
    if (!selectors || selectors.length === 0) return '';

    // Prefer aria selectors, then CSS selectors
    for (const selectorGroup of selectors) {
      for (const selector of selectorGroup) {
        if (selector.startsWith('aria/')) {
          return selector;
        }
      }
    }

    // Fall back to first CSS selector
    return selectors[0]?.[0] || '';
  }

  private describeSelector(selector: string): string {
    if (selector.startsWith('aria/')) {
      return `"${selector.replace('aria/', '')}"`;
    }
    if (selector.includes('button')) {
      return 'button';
    }
    if (selector.includes('input')) {
      return 'input field';
    }
    return `element (${selector.slice(0, 30)}...)`;
  }

  private describeStep(step: DevToolsStep): string {
    switch (step.type) {
      case 'navigate':
        return 'navigation';
      case 'click':
        return 'click action';
      case 'change':
        return 'value change';
      default:
        return step.type;
    }
  }

  private extractToolId(url: string): string | null {
    const match = url.match(/tool_id=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private toolIdToName(toolId: string): string {
    // Extract tool name from ID like "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0+galaxy4"
    const parts = toolId.split('/');
    if (parts.length >= 4) {
      return parts[parts.length - 2]; // Tool name is second to last
    }
    return toolId;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

export function convertRecording(
  recordingPath: string,
  options: ConversionOptions
): TutorialConfig {
  const converter = new RecordingConverter(recordingPath, options);
  return converter.convert();
}
