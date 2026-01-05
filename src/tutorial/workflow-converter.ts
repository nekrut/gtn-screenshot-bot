import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import {
  TutorialConfig,
  TutorialMetadata,
  Section,
  HandsOnStep,
  ToolStep,
  InputDatasetRef,
} from './types';
import { GalaxyHistoryClient, HistoryDetails } from '../galaxy/history-client';
import { HistoryEnricher } from './history-enricher';

interface WorkflowStep {
  id: number;
  type: string;
  tool_id?: string;
  tool_version?: string;
  name: string;
  annotation?: string;
  input_connections?: Record<string, unknown>;
  inputs?: Array<{ name: string; description?: string }>;
  outputs?: Array<{ name: string; type?: string }>;
  tool_state?: string;
}

interface GalaxyWorkflow {
  name: string;
  annotation?: string;
  tags?: string[];
  steps: Record<string, WorkflowStep>;
  creator?: Array<{ name?: string; identifier?: string }>;
}

export interface WorkflowConverterOptions {
  workflowPath?: string;
  workflowId?: string;
  galaxyUrl?: string;
  galaxyApiKey?: string;
  historyUrl?: string;
  topicName: string;
  tutorialName: string;
  trainingMaterialPath?: string;
  outputDir: string;
  imagesDir: string;
  usePlanemo?: boolean;
  metadata?: Partial<TutorialMetadata>;
}

export class WorkflowConverter {
  private options: WorkflowConverterOptions;

  constructor(options: WorkflowConverterOptions) {
    this.options = options;
  }

  async convert(): Promise<TutorialConfig> {
    if (this.options.usePlanemo) {
      return this.convertWithPlanemo();
    } else {
      return this.convertDirectly();
    }
  }

  /**
   * Convert workflow directly by parsing the .ga file
   */
  private async convertDirectly(): Promise<TutorialConfig> {
    if (!this.options.workflowPath) {
      throw new Error('Workflow path is required for direct conversion');
    }

    const workflowContent = fs.readFileSync(this.options.workflowPath, 'utf-8');
    const workflow: GalaxyWorkflow = JSON.parse(workflowContent);

    // Fetch history if URL provided
    let historyData: HistoryDetails | undefined;
    if (this.options.historyUrl && this.options.galaxyApiKey) {
      console.log('Fetching history data...');
      const historyClient = new GalaxyHistoryClient(
        this.options.galaxyUrl || 'https://usegalaxy.org',
        this.options.galaxyApiKey
      );
      historyData = await historyClient.fetchHistoryFromUrl(this.options.historyUrl);
      console.log(`  Found ${historyData.datasets.length} datasets in history "${historyData.name}"`);
    }

    return this.workflowToConfig(workflow, historyData);
  }

  /**
   * Convert workflow using planemo to generate tutorial skeleton first
   */
  private async convertWithPlanemo(): Promise<TutorialConfig> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtn-planemo-'));
    const trainingPath = this.options.trainingMaterialPath || tempDir;

    try {
      // Build planemo command
      const planemoArgs = [
        'training_generate_from_wf',
        `--topic_name=${this.options.topicName}`,
        `--tutorial_name=${this.options.tutorialName}`,
      ];

      if (this.options.workflowPath) {
        planemoArgs.push(`--workflow=${this.options.workflowPath}`);
      } else if (this.options.workflowId && this.options.galaxyUrl) {
        planemoArgs.push(`--workflow_id=${this.options.workflowId}`);
        planemoArgs.push(`--galaxy_url=${this.options.galaxyUrl}`);
        if (this.options.galaxyApiKey) {
          planemoArgs.push(`--galaxy_api_key=${this.options.galaxyApiKey}`);
        }
      } else {
        throw new Error('Either workflowPath or (workflowId + galaxyUrl) is required');
      }

      console.log('Running planemo to generate tutorial skeleton...');
      console.log(`  Command: planemo ${planemoArgs.join(' ')}`);

      // Run planemo
      execSync(`planemo ${planemoArgs.join(' ')}`, {
        cwd: trainingPath,
        stdio: 'inherit',
      });

      // Find generated tutorial
      const tutorialPath = path.join(
        trainingPath,
        'topics',
        this.options.topicName,
        'tutorials',
        this.options.tutorialName,
        'tutorial.md'
      );

      if (!fs.existsSync(tutorialPath)) {
        throw new Error(`Planemo did not generate tutorial at: ${tutorialPath}`);
      }

      console.log(`  Tutorial skeleton generated at: ${tutorialPath}`);

      // Parse generated tutorial
      return this.parsePlanemoTutorial(tutorialPath);
    } finally {
      // Cleanup temp directory if we created one
      if (!this.options.trainingMaterialPath) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Parse planemo-generated tutorial.md and convert to config
   */
  private parsePlanemoTutorial(tutorialPath: string): TutorialConfig {
    const content = fs.readFileSync(tutorialPath, 'utf-8');

    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let metadata: Partial<TutorialMetadata> = {};
    if (frontmatterMatch) {
      metadata = parseYaml(frontmatterMatch[1]);
    }

    // Extract hands-on sections with tool references
    const sections = this.extractSectionsFromTutorial(content);

    return {
      metadata: {
        title: metadata.title || this.options.tutorialName,
        questions: metadata.questions || ['What does this workflow do?'],
        objectives: metadata.objectives || ['Learn to run this workflow'],
        contributions: metadata.contributions || {
          authorship: ['your-github-username'],
        },
        level: metadata.level || 'Intermediate',
        ...this.options.metadata,
      },
      galaxy: {
        url: this.options.galaxyUrl || 'https://usegalaxy.org',
        api_key: this.options.galaxyApiKey,
      },
      ai: {
        provider: 'anthropic',
        generate_explanations: true,
      },
      output: {
        tutorial_dir: this.options.outputDir,
        images_dir: this.options.imagesDir,
      },
      sections,
    };
  }

  /**
   * Convert workflow JSON directly to config
   */
  private workflowToConfig(workflow: GalaxyWorkflow, historyData?: HistoryDetails): TutorialConfig {
    const sections: Section[] = [];

    // Introduction section
    sections.push({
      id: 'intro',
      title: 'Introduction',
      level: 1,
      type: 'intro',
      content: [
        {
          type: 'text',
          text: workflow.annotation || `This tutorial walks through the ${workflow.name} workflow.`,
        },
      ],
    });

    if (historyData) {
      // HISTORY-DRIVEN: Use executed steps from history (only tools that actually ran)
      const enricher = new HistoryEnricher(workflow, historyData);
      const executedSteps = enricher.enrichSteps();

      console.log(`  Found ${executedSteps.length} executed tool steps in history`);

      for (const enriched of executedSteps) {
        const toolName = enriched.toolName;

        // Build input_datasets from enriched data
        const inputDatasets: InputDatasetRef[] = enriched.inputDatasets.map(d => ({
          param_label: d.paramLabel,
          dataset_name: d.datasetName,
          dataset_id: d.datasetId,
          extension: d.extension,
        }));

        const toolStep: ToolStep = {
          tool_id: enriched.toolId,
          name: toolName,
          params: [], // Params will come from AI or workflow if matched
          input_datasets: inputDatasets.length ? inputDatasets : undefined,
          screenshot: {
            filename: `${this.slugify(toolName)}.png`,
            selector: '#center',
          },
        };

        sections.push({
          id: this.slugify(toolName),
          title: toolName,
          level: 2,
          type: 'hands_on',
          history_context: enriched.historyContext,
          steps: [{ type: 'tool_run', tool: toolStep }],
        });
      }
    } else {
      // WORKFLOW-ONLY: Use all tool steps from workflow (original behavior)
      const toolSteps = Object.values(workflow.steps)
        .filter((step) => step.type === 'tool' && step.tool_id)
        .sort((a, b) => a.id - b.id);

      for (const step of toolSteps) {
        const toolName = step.name || this.extractToolName(step.tool_id!);

        const toolStep: ToolStep = {
          tool_id: step.tool_id!,
          name: toolName,
          params: this.extractParams(step),
          screenshot: {
            filename: `${this.slugify(toolName)}.png`,
            selector: '#center',
          },
        };

        sections.push({
          id: this.slugify(toolName),
          title: toolName,
          level: 2,
          type: 'hands_on',
          steps: [{ type: 'tool_run', tool: toolStep }],
        });
      }
    }

    // Conclusion
    sections.push({
      id: 'conclusion',
      title: 'Conclusion',
      level: 1,
      type: 'conclusion',
      content: [
        {
          type: 'text',
          text: `You have successfully run the ${workflow.name} workflow.`,
        },
      ],
    });

    return {
      metadata: {
        title: workflow.name,
        questions: ['What does this workflow do?'],
        objectives: ['Learn to run this workflow step by step'],
        contributions: {
          authorship: workflow.creator?.map((c) => c.identifier || c.name || 'unknown') || ['your-github-username'],
        },
        level: 'Intermediate',
        tags: workflow.tags,
        ...this.options.metadata,
      },
      galaxy: {
        url: this.options.galaxyUrl || 'https://usegalaxy.org',
        api_key: this.options.galaxyApiKey,
      },
      ai: {
        provider: 'anthropic',
        generate_explanations: true,
      },
      output: {
        tutorial_dir: this.options.outputDir,
        images_dir: this.options.imagesDir,
      },
      sections,
    };
  }

  /**
   * Extract sections from tutorial markdown
   */
  private extractSectionsFromTutorial(content: string): Section[] {
    const sections: Section[] = [];

    // Find all tool references: {% tool [Name](toolid) %}
    const toolRegex = /{% tool \[([^\]]+)\]\(([^)]+)\) %}/g;
    const tools: Array<{ name: string; id: string }> = [];

    let match;
    while ((match = toolRegex.exec(content)) !== null) {
      tools.push({ name: match[1], id: match[2] });
    }

    // Create intro section
    sections.push({
      id: 'intro',
      title: 'Introduction',
      level: 1,
      type: 'intro',
      content: [
        {
          type: 'text',
          generate: true,
          prompt: 'Write a brief introduction for this workflow tutorial',
        },
      ],
    });

    // Create separate hands-on section for each tool
    for (const tool of tools) {
      sections.push({
        id: this.slugify(tool.name),
        title: tool.name,
        level: 2,
        type: 'hands_on',
        steps: [{
          type: 'tool_run',
          tool: {
            tool_id: tool.id,
            name: tool.name,
            params: [],
            screenshot: {
              filename: `${this.slugify(tool.name)}.png`,
              selector: '#center',
            },
          },
        }],
      });
    }

    // Conclusion
    sections.push({
      id: 'conclusion',
      title: 'Conclusion',
      level: 1,
      type: 'conclusion',
      content: [
        {
          type: 'text',
          generate: true,
          prompt: 'Summarize what was learned in this workflow tutorial',
        },
      ],
    });

    return sections;
  }

  /**
   * Extract tool name from tool_id
   */
  private extractToolName(toolId: string): string {
    // toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0+galaxy4 -> fastp
    const parts = toolId.split('/');
    if (parts.length >= 4) {
      return parts[parts.length - 2];
    }
    return toolId;
  }

  /**
   * Extract parameters from workflow step
   */
  private extractParams(step: WorkflowStep): ToolStep['params'] {
    const params: ToolStep['params'] = [];

    // Internal Galaxy fields to skip
    const skipFields = new Set([
      '__input_ext', '__target_datatype', '__workflow_invocation_uuid__',
      'chromInfo', '__job_resource', '__current_case__',
    ]);

    if (step.tool_state) {
      try {
        const state = JSON.parse(step.tool_state);
        // Extract non-connection params
        for (const [key, value] of Object.entries(state)) {
          // Skip internal fields and identifier fields
          if (skipFields.has(key) || key.includes('__identifier__')) continue;
          // Skip empty values and connection references
          if (typeof value === 'string' && value && !value.startsWith('{')) {
            params.push({
              label: key,
              value: value,
              icon: 'param-text',
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return params;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

export async function convertWorkflow(options: WorkflowConverterOptions): Promise<TutorialConfig> {
  const converter = new WorkflowConverter(options);
  return converter.convert();
}
