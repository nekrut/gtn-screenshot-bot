/**
 * History-to-Tutorial Converter
 * Generates GTN tutorials from a Galaxy history URL alone (no workflow needed)
 * Extracts exact tool parameters from job provenance
 */

import { GalaxyHistoryClient, HistoryDetails, HistoryCollection, ExecutedJob } from '../galaxy/history-client';
import { JobParamsClient, JobFullParams, DatasetInputRef } from '../galaxy/job-params';
import { FormMapper } from '../galaxy/form-mapper';
import { TutorialConfig, Section, ToolStep, TutorialMetadata } from './types';

export interface HistoryConverterOptions {
  galaxyUrl: string;
  apiKey: string;
  historyUrl: string;
  outputDir: string;
  imagesDir: string;
  title?: string;
  skipInternal?: boolean;  // Filter internal/helper tools (default: true)
}

export interface ConvertedJob {
  job: JobFullParams;
  toolName: string;
  stepNumber: number;
  inputCollections: Map<string, { hid: number; name: string }>;
  inputDatasets: Map<string, { hid: number; name: string }>;
}

export class HistoryConverter {
  private historyClient: GalaxyHistoryClient;
  private jobParamsClient: JobParamsClient;
  private formMapper: FormMapper;
  private options: HistoryConverterOptions;
  private resolvedHistoryId?: string;

  constructor(options: HistoryConverterOptions) {
    this.options = options;
    this.historyClient = new GalaxyHistoryClient(options.galaxyUrl, options.apiKey);
    this.jobParamsClient = new JobParamsClient(options.galaxyUrl, options.apiKey);
    this.formMapper = new FormMapper(options.galaxyUrl, options.apiKey);
  }

  /**
   * Main conversion: History URL -> TutorialConfig
   */
  async convert(): Promise<TutorialConfig> {
    console.log('History-to-Tutorial Conversion');
    console.log('==============================');

    // 1. Fetch history + jobs + collections
    console.log('\n1. Fetching history...');
    const history = await this.historyClient.fetchHistoryFromUrl(this.options.historyUrl);

    // 2. Group jobs by tool_id (handles collection deduplication)
    // Jobs are pre-sorted by create_time from the API
    console.log('\n2. Processing jobs...');

    // Count jobs per tool_id to identify map-over tools (multiple jobs = map-over)
    const jobCountByTool = new Map<string, number>();
    for (const job of history.jobs) {
      jobCountByTool.set(job.tool_id, (jobCountByTool.get(job.tool_id) || 0) + 1);
    }

    const uniqueJobs = this.historyClient.groupJobsByTool(history.jobs);
    // Sort by create_time to ensure correct order
    uniqueJobs.sort((a, b) => new Date(a.create_time).getTime() - new Date(b.create_time).getTime());
    console.log(`   ${history.jobs.length} total jobs -> ${uniqueJobs.length} unique tools`);

    // Log job counts per tool
    for (const job of uniqueJobs) {
      const count = jobCountByTool.get(job.tool_id) || 1;
      console.log(`     ${job.tool_id.split('/').slice(-2, -1)[0]}: ${count} job(s)`);
    }

    // 3. Fetch full params for each unique job
    console.log('\n3. Fetching job parameters...');
    const jobIds = uniqueJobs.map(j => j.id);
    const jobsWithParams = await this.jobParamsClient.fetchAllJobParams(jobIds);
    console.log(`   Retrieved params for ${jobsWithParams.length} jobs`);

    // 4. Build DCE -> Collection map for resolving collection inputs
    console.log('\n4. Building collection map...');
    const parsed = this.historyClient.parseHistoryUrl(this.options.historyUrl);
    let historyId: string;
    if (parsed.historyId) {
      historyId = parsed.historyId;
    } else if (parsed.published) {
      historyId = await this.historyClient.resolvePublishedHistory(
        parsed.published.username,
        parsed.published.slug
      );
    } else {
      throw new Error('Could not determine history ID');
    }
    // Store for later use and set on formMapper (required for tool schema API)
    this.resolvedHistoryId = historyId;
    this.formMapper.setHistoryId(historyId);
    const dceMap = await this.historyClient.buildDceToCollectionMap(historyId);
    console.log(`   Mapped ${dceMap.size} collection elements`);

    // 5. Convert jobs to tutorial sections
    console.log('\n5. Building tutorial config...');
    const convertedJobs = await this.convertJobs(jobsWithParams, history, dceMap, jobCountByTool);
    const config = this.buildTutorialConfig(convertedJobs, history);

    console.log(`\nGenerated config with ${config.sections.length} sections`);
    return config;
  }

  /**
   * Convert job params to ConvertedJob with resolved inputs
   */
  private async convertJobs(
    jobs: JobFullParams[],
    history: HistoryDetails,
    dceMap: Map<string, HistoryCollection>,
    jobCountByTool: Map<string, number>
  ): Promise<ConvertedJob[]> {
    const converted: ConvertedJob[] = [];

    // Build collection ID -> collection map
    const collectionById = new Map<string, HistoryCollection>();
    for (const coll of history.collections) {
      collectionById.set(coll.id, coll);
    }

    // Build dataset ID -> dataset map
    const datasetById = new Map<string, { hid: number; name: string }>();
    for (const ds of history.datasets) {
      datasetById.set(ds.id, { hid: ds.hid, name: ds.name });
    }

    // Identify input collections (no job_source_id = user uploaded)
    // vs output collections (has job_source_id = created by a tool)
    const userInputCollections = history.collections.filter(c => !c.job_source_id);
    const toolOutputCollections = history.collections.filter(c => c.job_source_id);

    // Track which collections have been "consumed" as outputs by previous jobs
    const outputCollectionIds = new Set<string>();

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const inputCollections = new Map<string, { hid: number; name: string }>();
      const inputDatasets = new Map<string, { hid: number; name: string }>();

      // Check if this is a map-over tool (multiple jobs = ran on collection elements)
      const jobCount = jobCountByTool.get(job.toolId) || 1;
      const isMapOverTool = jobCount > 1;
      const hasCollectionInput = Object.values(job.params).some(p => p.isCollection);

      console.log(`   Job ${i + 1} (${job.toolName}): isMapOverTool=${isMapOverTool} (${jobCount} jobs)`);

      if (isMapOverTool && hasCollectionInput) {
        // MAP-OVER TOOLS: Track input collection from history chain
        let inputColl: HistoryCollection | undefined;

        if (i === 0) {
          // First job - input is user-uploaded collection
          inputColl = userInputCollections.sort((a, b) => a.hid - b.hid)[0];
        } else {
          // Subsequent jobs - find unprocessed output collection
          inputColl = toolOutputCollections
            .filter(c => !outputCollectionIds.has(c.id))
            .sort((a, b) => a.hid - b.hid)[0];
        }

        if (inputColl) {
          console.log(`     Map-over input: ${inputColl.hid}: ${inputColl.name}`);
          for (const [paramName, param] of Object.entries(job.params)) {
            if (param.isCollection) {
              inputCollections.set(paramName, { hid: inputColl.hid, name: inputColl.name });
              outputCollectionIds.add(inputColl.id);
              break;
            }
          }
        }
      } else if (!isMapOverTool) {
        // SINGLE-JOB TOOLS: Fetch input collections from output dataset's parameters_display
        // This gives us the exact input collection info from Galaxy
        const outputs = job.outputs as Record<string, { id?: string; src?: string }>;
        for (const output of Object.values(outputs)) {
          if (output.id && output.src === 'hda') {
            console.log(`     Fetching input collections from output dataset ${output.id}...`);
            const inputRefs = await this.jobParamsClient.fetchDatasetInputCollections(output.id);
            for (const ref of inputRefs) {
              if (ref.src === 'hdca') {
                const firstInputName = Object.keys(job.inputs)[0] || 'input';
                inputCollections.set(firstInputName, { hid: ref.hid, name: ref.name });
                console.log(`     Found input collection: ${ref.hid}: ${ref.name}`);
              }
            }
            break; // Only need first output
          }
        }
      }

      // Resolve any remaining hda inputs
      for (const [inputName, inputRef] of Object.entries(job.inputs)) {
        if ((inputRef.src === 'hda' || inputRef.src === 'ldda') && !inputCollections.size) {
          const ds = datasetById.get(inputRef.id);
          if (ds) {
            inputDatasets.set(inputName, ds);
          }
        }
      }

      converted.push({
        job,
        toolName: job.toolName,
        stepNumber: i + 1,
        inputCollections,
        inputDatasets,
      });
    }

    return converted;
  }

  /**
   * Build TutorialConfig from converted jobs
   */
  private buildTutorialConfig(jobs: ConvertedJob[], history: HistoryDetails): TutorialConfig {
    const sections: Section[] = [];

    // Intro section
    sections.push({
      id: 'intro',
      title: 'Introduction',
      type: 'intro',
      content: [
        {
          type: 'text',
          text: `This tutorial was generated from Galaxy history "${history.name}". ` +
            `It shows the ${jobs.length} tools that were executed and their settings.`,
        },
      ],
    });

    // Tool sections
    for (const convertedJob of jobs) {
      const section = this.buildToolSection(convertedJob);
      sections.push(section);
    }

    // Conclusion section
    sections.push({
      id: 'conclusion',
      title: 'Conclusion',
      type: 'conclusion',
      content: [
        {
          type: 'text',
          text: 'You have successfully completed the analysis workflow.',
        },
      ],
    });

    // Build metadata
    const metadata: TutorialMetadata = {
      title: this.options.title || history.name || 'Tutorial',
      questions: ['What does this analysis accomplish?'],
      objectives: ['Run the tools with the specified parameters'],
      level: 'Intermediate',
      contributions: {
        authorship: ['gtn-screenshot-bot'],
      },
    };

    return {
      metadata,
      galaxy: {
        url: this.options.galaxyUrl,
        api_key: this.options.apiKey,
      },
      ai: {
        provider: 'anthropic',
        generate_explanations: true,
      },
      output: {
        tutorial_dir: this.options.outputDir,
        images_dir: this.options.imagesDir.startsWith(this.options.outputDir)
          ? this.options.imagesDir
          : `${this.options.outputDir}/images`,
      },
      sections,
    };
  }

  /**
   * Build a tutorial section for a single tool
   */
  private buildToolSection(convertedJob: ConvertedJob): Section {
    const { job, toolName, inputCollections, inputDatasets } = convertedJob;

    // Build params list for tutorial (non-default values only)
    const params: Array<{ label: string; value: string }> = [];

    // Add input collections/datasets as params for display
    for (const [inputName, info] of inputCollections) {
      params.push({
        label: inputName,
        value: `${info.hid}: ${info.name}`,
      });
    }

    for (const [inputName, info] of inputDatasets) {
      params.push({
        label: inputName,
        value: `${info.hid}: ${info.name}`,
      });
    }

    // Slug for section ID
    const slug = this.slugify(toolName);

    // Build ToolStep - always use job_id rerun + text replacement for collection inputs
    const toolConfig: ToolStep = {
      tool_id: job.toolId,
      name: toolName,
      params,
      screenshot: {
        filename: `${slug}.png`,
        selector: '#center',
      },
      job_params: job,
      input_collections: Object.fromEntries(inputCollections),
      resolved_inputs: Object.fromEntries(inputDatasets),
    };

    // HandsOnStep wraps the tool config
    const handsOnStep = {
      type: 'tool_run' as const,
      tool: toolConfig,
    };

    return {
      id: slug,
      title: toolName,
      type: 'hands_on',
      steps: [handsOnStep],
    };
  }

  /**
   * Create URL-safe slug from tool name
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Get form mapper for external use (e.g., by generator)
   */
  getFormMapper(): FormMapper {
    return this.formMapper;
  }

  /**
   * Get history client for external use
   */
  getHistoryClient(): GalaxyHistoryClient {
    return this.historyClient;
  }

  /**
   * Get job params client for external use
   */
  getJobParamsClient(): JobParamsClient {
    return this.jobParamsClient;
  }
}
