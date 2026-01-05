import * as fs from 'fs';
import * as path from 'path';
import { GalaxyClient } from '../galaxy/client';
import { Screenshot, Step, CaptureStep } from '../config/types';
import { annotateImage } from './annotate';

export class ScreenshotRunner {
  private client: GalaxyClient;
  private outputDir: string;

  constructor(client: GalaxyClient, outputDir: string) {
    this.client = client;
    this.outputDir = outputDir;
  }

  async runScreenshot(screenshot: Screenshot): Promise<string> {
    console.log(`Capturing: ${screenshot.id} - ${screenshot.description || ''}`);

    for (const step of screenshot.steps) {
      await this.executeStep(step, screenshot);
    }

    // Find the capture step and return the output path
    const captureStep = screenshot.steps.find((s) => s.action === 'capture') as CaptureStep;
    const outputPath = path.join(this.outputDir, screenshot.output);

    return outputPath;
  }

  private async executeStep(step: Step, screenshot: Screenshot): Promise<void> {
    switch (step.action) {
      case 'open_tool':
        await this.client.openTool(step.tool_id);
        break;

      case 'set_param':
        await this.client.setParameter(step.param, step.value);
        break;

      case 'click':
        await this.client.click(step.selector);
        break;

      case 'wait':
        await this.client.wait({ ms: step.ms, selector: step.selector });
        break;

      case 'navigate':
        await this.client.navigate(step.url);
        break;

      case 'capture':
        await this.captureAndSave(step, screenshot);
        break;
    }
  }

  private async captureAndSave(step: CaptureStep, screenshot: Screenshot): Promise<void> {
    // Capture screenshot
    let imageBuffer = await this.client.captureScreenshot({
      selector: step.selector,
      fullPage: step.fullPage,
    });

    // Apply annotations if any
    if (step.annotations && step.annotations.length > 0) {
      imageBuffer = await annotateImage(
        imageBuffer,
        step.annotations,
        async (selector) => this.client.getElementBounds(selector)
      );
    }

    // Ensure output directory exists
    const outputPath = path.join(this.outputDir, screenshot.output);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save to file
    fs.writeFileSync(outputPath, imageBuffer);
    console.log(`  Saved: ${outputPath}`);
  }
}
