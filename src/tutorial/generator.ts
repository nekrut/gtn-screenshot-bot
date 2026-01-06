import * as fs from 'fs';
import * as path from 'path';
import { GalaxyClient } from '../galaxy/client';
import { annotateImage } from '../capture/annotate';
import {
  TutorialConfig,
  Section,
  HandsOnStep,
  ToolStep,
  ToolParam,
  ScreenshotStep,
  ScreenshotAnnotation,
  DetailsBlock,
  ContentElement,
  GeneratedTutorial,
  GeneratedImage,
  TutorialMetadata,
  QuestionContent,
  QuoteContent,
  TipContent,
  WarningContent,
  SnippetContent,
} from './types';
import { AIGenerator } from './ai-generator';
import { FormMapper } from '../galaxy/form-mapper';
import { GalaxyHistoryClient } from '../galaxy/history-client';
import { JobParamsClient } from '../galaxy/job-params';

export interface GeneratorOptions {
  formMapper?: FormMapper;
  historyClient?: GalaxyHistoryClient;
  jobParamsClient?: JobParamsClient;
}

export class TutorialGenerator {
  private config: TutorialConfig;
  private client: GalaxyClient;
  private ai: AIGenerator | null;
  private images: GeneratedImage[] = [];
  private formMapper?: FormMapper;
  private historyClient?: GalaxyHistoryClient;
  private jobParamsClient?: JobParamsClient;

  constructor(config: TutorialConfig, options?: GeneratorOptions) {
    this.config = config;
    this.client = new GalaxyClient(config.galaxy.url);
    this.ai = config.ai ? new AIGenerator(config.ai) : null;
    this.formMapper = options?.formMapper;
    this.historyClient = options?.historyClient;
    this.jobParamsClient = options?.jobParamsClient;
  }

  async generate(): Promise<GeneratedTutorial> {
    await this.client.init();

    try {
      // Login if credentials provided
      if (this.config.galaxy.credentials) {
        await this.client.login(
          this.config.galaxy.credentials.username,
          this.config.galaxy.credentials.password
        );
      } else if (this.config.galaxy.api_key) {
        await this.client.loginWithApiKey(this.config.galaxy.api_key);
      } else {
        await this.client.navigate();
      }

      // Generate frontmatter
      const frontmatter = await this.generateFrontmatter();

      // Generate content sections
      const contentParts: string[] = [];

      for (const section of this.config.sections) {
        const sectionContent = await this.generateSection(section);
        contentParts.push(sectionContent);
      }

      const content = contentParts.join('\n\n');

      return {
        frontmatter,
        content,
        images: this.images,
      };
    } finally {
      await this.client.close();
    }
  }

  async save(): Promise<void> {
    const tutorial = await this.generate();

    // Create output directories
    const tutorialDir = this.config.output.tutorial_dir;
    const imagesDir = this.config.output.images_dir;

    fs.mkdirSync(tutorialDir, { recursive: true });
    fs.mkdirSync(imagesDir, { recursive: true });

    // Write tutorial.md
    const tutorialPath = path.join(tutorialDir, 'tutorial.md');
    const fullContent = `${tutorial.frontmatter}\n\n${tutorial.content}`;
    fs.writeFileSync(tutorialPath, fullContent);
    console.log(`Tutorial saved: ${tutorialPath}`);

    // Write images
    for (const image of tutorial.images) {
      const imagePath = path.join(imagesDir, image.filename);
      fs.writeFileSync(imagePath, image.data);
      console.log(`Image saved: ${imagePath}`);
    }
  }

  private async generateFrontmatter(): Promise<string> {
    const meta = this.config.metadata;

    // Generate key points if AI is available and configured
    let keyPoints = meta.key_points || [];
    if (this.ai && this.config.ai?.generate_key_points && keyPoints.length === 0) {
      keyPoints = await this.ai.generateKeyPoints(this.config);
    }

    const frontmatter: Record<string, unknown> = {
      layout: meta.layout || 'tutorial_hands_on',
      title: meta.title,
    };

    if (meta.zenodo_link) frontmatter.zenodo_link = meta.zenodo_link;

    frontmatter.questions = meta.questions;
    frontmatter.objectives = meta.objectives;

    if (meta.time_estimation) frontmatter.time_estimation = meta.time_estimation;
    if (meta.level) frontmatter.level = meta.level;
    if (keyPoints.length > 0) frontmatter.key_points = keyPoints;
    if (meta.subtopic) frontmatter.subtopic = meta.subtopic;
    if (meta.priority) frontmatter.priority = meta.priority;
    if (meta.tags && meta.tags.length > 0) frontmatter.tags = meta.tags;

    frontmatter.contributions = meta.contributions;

    // Abbreviations for auto-expansion
    if (meta.abbreviations && Object.keys(meta.abbreviations).length > 0) {
      frontmatter.abbreviations = meta.abbreviations;
    }

    // Example histories
    if (meta.answer_histories && meta.answer_histories.length > 0) {
      frontmatter.answer_histories = meta.answer_histories;
    }
    if (meta.input_histories && meta.input_histories.length > 0) {
      frontmatter.input_histories = meta.input_histories;
    }

    // Convert to YAML-like format
    return '---\n' + this.objectToYaml(frontmatter) + '---';
  }

  private objectToYaml(obj: Record<string, unknown>, indent = 0): string {
    const spaces = '  '.repeat(indent);
    let result = '';

    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        result += `${spaces}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            result += `${spaces}- ` + this.objectToYaml(item as Record<string, unknown>, indent + 1).trimStart();
          } else {
            result += `${spaces}- ${item}\n`;
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        result += `${spaces}${key}:\n`;
        result += this.objectToYaml(value as Record<string, unknown>, indent + 1);
      } else {
        result += `${spaces}${key}: ${value}\n`;
      }
    }

    return result;
  }

  private async generateSection(section: Section): Promise<string> {
    const parts: string[] = [];

    // Section heading
    const headingLevel = '#'.repeat(section.level || 2);
    parts.push(`${headingLevel} ${section.title}`);

    // Generate intro content
    if (section.content) {
      for (const element of section.content) {
        const elementContent = await this.generateContentElement(element, section);
        parts.push(elementContent);
      }
    }

    // Add agenda box after first intro section (typically after introduction)
    if (section.type === 'intro' && section.id === 'intro') {
      parts.push(this.generateAgendaBox());
    }

    // Generate details blocks
    if (section.details_blocks) {
      for (const details of section.details_blocks) {
        const detailsContent = await this.generateDetailsBlock(details);
        parts.push(detailsContent);
      }
    }

    // Generate hands-on section
    if (section.type === 'hands_on' && section.steps) {
      const handsOnContent = await this.generateHandsOn(section);
      parts.push(handsOnContent);
    }

    return parts.join('\n\n');
  }

  private generateAgendaBox(): string {
    return `> <agenda-title></agenda-title>
>
> In this tutorial, we will cover:
>
> 1. TOC
> {:toc}
>
{: .agenda}`;
  }

  private async generateContentElement(element: ContentElement, context: Section): Promise<string> {
    switch (element.type) {
      case 'text':
        if (element.generate && this.ai) {
          let text = await this.ai.generateText(element.prompt || '', context);
          // Strip leading headings from AI-generated text (we already have section headings)
          text = text.replace(/^#+\s+.*\n+/, '');
          return text;
        }
        return element.text || '';

      case 'image':
        if (element.caption) {
          return `![${element.alt}](${element.src} "${element.caption}")`;
        }
        return `![${element.alt}](${element.src})`;

      case 'table':
        return this.generateTable(element.headers, element.rows);

      case 'code':
        return '```' + (element.language || '') + '\n' + element.code + '\n```';

      case 'tool_mention':
        return `{% tool [${element.name}](${element.tool_id}) %}`;

      case 'question':
        return this.generateQuestionBox(element as QuestionContent);

      case 'quote':
        return this.generateQuoteBox(element as QuoteContent);

      case 'tip':
        return this.generateTipBox(element as TipContent);

      case 'warning':
        return this.generateWarningBox(element as WarningContent);

      case 'snippet':
        return this.generateSnippet(element as SnippetContent);

      default:
        return '';
    }
  }

  private generateQuestionBox(question: QuestionContent): string {
    const title = question.title || '';
    const questionsList = question.questions.map((q, i) => `> ${i + 1}. ${q}`).join('\n');

    let content = `> <question-title>${title}</question-title>
>
${questionsList}`;

    if (question.solution) {
      const solutionTitle = question.solution.title || '';
      const answersList = question.solution.answers.map((a, i) => `> > ${i + 1}. ${a}`).join('\n');
      content += `
>
> > <solution-title>${solutionTitle}</solution-title>
> >
${answersList}
> >
> {: .solution}`;
    }

    content += '\n{: .question}';
    return content;
  }

  private generateQuoteBox(quote: QuoteContent): string {
    let attrs = '';
    if (quote.cite) attrs += ` cite="${quote.cite}"`;
    if (quote.author) attrs += ` author="${quote.author}"`;

    return `> ${quote.text}
{: .quote${attrs}}`;
  }

  private generateTipBox(tip: TipContent): string {
    return `> <tip-title>${tip.title}</tip-title>
>
${this.indentBlock(tip.text, '> ')}
{: .tip}`;
  }

  private generateWarningBox(warning: WarningContent): string {
    return `> <warning-title>${warning.title}</warning-title>
>
${this.indentBlock(warning.text, '> ')}
{: .warning}`;
  }

  private generateSnippet(snippet: SnippetContent): string {
    if (snippet.box_type && snippet.box_type !== 'none') {
      return `{% snippet ${snippet.path} box_type="${snippet.box_type}" %}`;
    }
    return `{% snippet ${snippet.path} %}`;
  }

  private generateTable(headers: string[], rows: string[][]): string {
    const headerRow = '| ' + headers.join(' | ') + ' |';
    const separator = '|' + headers.map(() => '---').join('|') + '|';
    const dataRows = rows.map((row) => '| ' + row.join(' | ') + ' |');
    return [headerRow, separator, ...dataRows].join('\n');
  }

  private async generateDetailsBlock(details: DetailsBlock): Promise<string> {
    let content = details.content || '';

    if (details.generate && this.ai && details.topic) {
      content = await this.ai.generateDetailsContent(details.topic);
    }

    // Add images if any
    if (details.images) {
      for (const img of details.images) {
        if (img.caption) {
          content += `\n\n![${img.alt}](${img.src} "${img.caption}")`;
        } else {
          content += `\n\n![${img.alt}](${img.src})`;
        }
      }
    }

    return `> <details-title>${details.title}</details-title>
>
${this.indentBlock(content, '> ')}
{: .details}`;
  }

  private async generateHandsOn(section: Section): Promise<string> {
    const parts: string[] = [];

    // Generate AI explanation for the tool if AI is configured
    if (this.ai && section.steps && section.steps.length > 0) {
      const firstStep = section.steps[0];
      if (firstStep.type === 'tool_run' && firstStep.tool) {
        const tool = firstStep.tool;
        const params = tool.params.map(p => ({ label: p.label, value: p.value }));
        try {
          // Use history context if available for richer explanations
          const explanation = section.history_context
            ? await this.ai.generateToolExplanationWithContext(
                tool.name,
                tool.tool_id,
                params,
                section.history_context
              )
            : await this.ai.generateToolExplanation(tool.name, tool.tool_id, params);
          if (explanation) {
            parts.push(explanation);
            parts.push('');
          }
        } catch (error) {
          console.warn(`  Warning: Could not generate tool explanation for ${tool.name}`);
        }
      }
    }

    // Generate numbered steps
    const steps: string[] = [];
    let stepNumber = 1;

    for (const step of section.steps || []) {
      const stepContent = await this.generateHandsOnStep(step, stepNumber);
      if (stepContent) {
        if (step.type === 'instruction' || step.type === 'tool_run') {
          steps.push(`${stepNumber}. ${stepContent}`);
          stepNumber++;
        } else {
          steps.push(stepContent);
        }
      }
    }

    parts.push(...steps);

    const handsOnTitle = section.title || 'Hands-on';

    return `> <hands-on-title>${handsOnTitle}</hands-on-title>
>
${this.indentBlock(parts.join('\n'), '> ')}
{: .hands_on}`;
  }

  private async generateHandsOnStep(step: HandsOnStep, stepNumber: number): Promise<string> {
    switch (step.type) {
      case 'instruction':
        return step.text || '';

      case 'tool_run':
        return await this.generateToolStep(step.tool!);

      case 'screenshot':
        return await this.generateScreenshotStep(step.screenshot!);

      case 'note':
        return this.generateNote(step.note!);

      default:
        return '';
    }
  }

  private async generateToolStep(tool: ToolStep): Promise<string> {
    const parts: string[] = [];
    let toolOpened = false;

    // Navigate to tool if screenshot is needed
    if (tool.screenshot) {
      console.log(`  Opening tool: ${tool.tool_id}`);
      try {
        // Choose rerun method based on tool type:
        // - Single-dataset output: use /tool_runner/rerun?id=<dataset_id> (shows correct inputs)
        // - Map-over (collection) output: use job_id rerun + text replacement
        const rerunDatasetId = tool.rerun_dataset_id;
        const jobId = tool.job_params?.jobId;

        await this.client.openTool(tool.tool_id, jobId, rerunDatasetId);
        toolOpened = true;

        // Give extra time for rerun form to fully populate
        if (rerunDatasetId || jobId) {
          await this.client.wait({ ms: 2000 });

          // Handle collection inputs
          if (tool.input_collections && Object.keys(tool.input_collections).length > 0) {
            for (const [paramName, collInfo] of Object.entries(tool.input_collections)) {
              const collectionText = `${collInfo.hid}: ${collInfo.name}`;

              // Try 1: Replace text if field shows "(as dataset collection)" - for map-over tools
              const replaced = await this.client.replaceCollectionInputText(collectionText);

              // Try 2: Select from dropdown if field is empty - for single-job tools
              if (!replaced) {
                await this.client.selectCollectionByHid(paramName, collInfo.hid, collInfo.name);
              }
            }
          }
        }
        // Legacy: manually select input datasets if no job_params
        else if (tool.input_datasets && tool.input_datasets.length > 0) {
          console.log(`  Selecting ${tool.input_datasets.length} input dataset(s)...`);
          for (const inputDs of tool.input_datasets) {
            await this.client.selectDatasetInput(inputDs.param_label, inputDs.dataset_name);
          }
        }
      } catch (error) {
        console.error(`  Warning: Failed to open tool ${tool.tool_id}:`, error instanceof Error ? error.message : error);
      }
    }

    // Tool reference with {% tool %} syntax
    parts.push(`**${tool.name}** {% icon tool %} with the following parameters:`);

    // Add input datasets as param-file entries
    if (tool.input_datasets && tool.input_datasets.length > 0) {
      for (const inputDs of tool.input_datasets) {
        parts.push(`   - {% icon param-file %} *"${inputDs.param_label}"*: \`${inputDs.dataset_name}\``);
      }
    }

    // Parameters with icons
    for (const param of tool.params) {
      const paramLine = this.formatToolParam(param, 3);
      parts.push(paramLine);
    }

    // Screenshot if configured and tool was opened successfully
    if (tool.screenshot && toolOpened) {
      try {
        // Generate annotations for non-default parameters using parameters_display
        let screenshotWithAnnotations = { ...tool.screenshot };
        const jobId = tool.job_params?.jobId;
        if (jobId && this.jobParamsClient && this.formMapper) {
          try {
            const paramsDisplay = await this.jobParamsClient.fetchJobParametersDisplay(jobId);

            // Get tool schema defaults for comparison (includes option mappings)
            const schemaInfo = await this.getSchemaDefaultsWithOptions(tool.tool_id);

            // Filter to params that differ from defaults
            const changedParams = paramsDisplay.filter(p => {
              // Skip section headers (null value)
              if (p.value === null) return false;
              // Skip "Not available." which means hidden/conditional
              if (p.value === 'Not available.') return false;
              // Skip empty strings
              if (p.value === '') return false;
              // Skip "Nothing selected" - empty optional inputs
              if (p.value === 'Nothing selected') return false;
              // Skip empty arrays (empty optional multi-inputs)
              if (Array.isArray(p.value) && p.value.length === 0) return false;

              // Check if this is a data input (has src field in value)
              const isDataInput = typeof p.value === 'object' && p.value !== null &&
                (Array.isArray(p.value) ? p.value.some((v: Record<string, unknown>) => v.src) : (p.value as Record<string, unknown>).src);

              // Always show data inputs that have actual selections (user must configure these)
              if (isDataInput) return true;

              // Compare against schema default
              const fieldInfo = schemaInfo.get(p.text);
              if (fieldInfo) {
                const { defaultLabel, defaultValue, options } = fieldInfo;

                // Normalize values for comparison (handle string/number type differences)
                const normalize = (v: unknown): unknown => {
                  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
                    return parseFloat(v);
                  }
                  return v;
                };

                const currentNorm = normalize(p.value);

                // Check if current value matches default (by label or by internal value)
                if (options && options.length > 0 && typeof p.value === 'string') {
                  // For select fields, check if current matches default option (by value or label)
                  const currentMatchesDefault = options.some(opt => {
                    const isDefaultOption = opt.label === defaultLabel || opt.value === defaultValue;
                    const matchesCurrent = opt.value === p.value || opt.label === p.value;
                    return isDefaultOption && matchesCurrent;
                  });
                  if (currentMatchesDefault) return false;

                  // If no match, it's changed
                  console.log(`    ${p.text}: changed from ${JSON.stringify(defaultLabel)} to ${JSON.stringify(p.value)}`);
                  return true;
                }

                // Non-select field comparison
                const defaultNorm = normalize(defaultLabel);
                const currentStr = JSON.stringify(currentNorm);
                const defaultStr = JSON.stringify(defaultNorm);
                const isChanged = currentStr !== defaultStr;
                if (isChanged) {
                  console.log(`    ${p.text}: changed from ${defaultStr} to ${currentStr}`);
                }
                return isChanged;
              }

              // If no schema info found, skip common default patterns
              if (p.value === false || p.value === true) return false;
              // Skip small integers (likely defaults)
              if (typeof p.value === 'number' && p.value >= 0 && p.value <= 10) {
                return false;
              }
              // Skip numeric strings that look like defaults
              if (typeof p.value === 'string' && /^[0-9]+$/.test(p.value)) {
                const num = parseInt(p.value, 10);
                if (num <= 10) return false;
              }

              return false; // Skip unknown params
            });

            if (changedParams.length > 0) {
              console.log(`  Annotating ${changedParams.length} changed parameter(s)`);
              const annotations: ScreenshotAnnotation[] = [...(tool.screenshot.annotations || [])];

              for (const param of changedParams) {
                const escapedText = param.text.replace(/"/g, '\\"');
                // Use arrow pointing to the element from the right
                annotations.push({
                  type: 'arrow',
                  from: [50, 0], // Offset from right edge of element
                  to: `:text-is("${escapedText}")`,
                  color: 'red',
                } as ScreenshotAnnotation);
              }

              screenshotWithAnnotations = { ...tool.screenshot, annotations };

              // Add list of changed parameters above screenshot
              const changedList = changedParams.map(p => {
                // Format value for display
                let valueStr = '';
                if (typeof p.value === 'object' && p.value !== null) {
                  // Data input - check if we have resolved collection info
                  let foundCollection = false;
                  if (tool.input_collections) {
                    for (const [, collInfo] of Object.entries(tool.input_collections)) {
                      // Use resolved collection name (hid: name format)
                      valueStr = `${collInfo.hid}: ${collInfo.name}`;
                      foundCollection = true;
                      break;
                    }
                  }
                  if (!foundCollection) {
                    const val = p.value as Record<string, unknown>;
                    if (val.name) {
                      valueStr = String(val.name);
                    } else if (Array.isArray(p.value) && p.value.length > 0) {
                      const first = p.value[0] as Record<string, unknown>;
                      valueStr = first.name ? String(first.name) : '[collection]';
                    }
                  }
                } else {
                  valueStr = String(p.value);
                }
                return `>    - *"${p.text}"*: \`${valueStr}\``;
              }).join('\n');

              parts.push('');
              parts.push(`> <comment-title>Key parameters to change</comment-title>\n>\n${changedList}\n{: .comment}`);
            }
          } catch (annotationError) {
            console.log(`  Could not generate annotations: ${annotationError instanceof Error ? annotationError.message : annotationError}`);
            // Continue without annotations
          }
        }

        const screenshotContent = await this.generateScreenshotStep(screenshotWithAnnotations);
        parts.push('');
        parts.push(screenshotContent);
      } catch (error) {
        console.error(`  Warning: Failed to capture screenshot:`, error instanceof Error ? error.message : error);
      }
    }

    // Output description
    if (tool.output_description) {
      parts.push('');
      parts.push(tool.output_description);
    }

    return parts.join('\n');
  }

  /**
   * Get schema defaults as a map of display label -> default value
   */
  private async getSchemaDefaults(toolId: string): Promise<Map<string, unknown>> {
    const defaults = new Map<string, unknown>();

    if (!this.formMapper) return defaults;

    try {
      const schema = await this.formMapper.fetchToolFormSchema(toolId);

      // Recursively extract defaults from schema inputs
      const extractDefaults = (inputs: Array<{
        name: string;
        label?: string;
        title?: string;
        value?: unknown;
        type: string;
        options?: Array<{ value: string; label: string }>;
        inputs?: Array<unknown>;
        cases?: Array<{ inputs: Array<unknown> }>;
        test_param?: { label?: string; value?: unknown; options?: Array<{ value: string; label: string }> };
      }>) => {
        for (const input of inputs) {
          // Get display label
          const label = input.title || input.label || input.name;

          // Store default value - for select fields, use the option label instead of value
          if (input.value !== undefined) {
            let defaultToStore = input.value;
            // For select fields with options, find the label for the default value
            if (input.type === 'select' && typeof input.value === 'string') {
              if (input.options && input.options.length > 0) {
                // Galaxy options can be [{value, label}] or [[label, value, selected]]
                const firstOpt = input.options[0];
                if (Array.isArray(firstOpt)) {
                  // Array format: [label, value, selected]
                  const selectedOption = (input.options as unknown as Array<[string, string, boolean]>)
                    .find(o => o[1] === input.value);
                  if (selectedOption) {
                    defaultToStore = selectedOption[0]; // label is first element
                  }
                } else {
                  // Object format: {value, label}
                  const selectedOption = input.options.find(o => o.value === input.value);
                  if (selectedOption) {
                    defaultToStore = selectedOption.label;
                  }
                }
              }
            }
            defaults.set(label, defaultToStore);
          }

          // Handle conditional test_param
          if (input.type === 'conditional' && input.test_param) {
            const testLabel = input.test_param.label || input.name;
            if (input.test_param.value !== undefined) {
              let defaultToStore = input.test_param.value;
              // For select test_params, use option label
              if (input.test_param.options && input.test_param.options.length > 0 && typeof input.test_param.value === 'string') {
                const firstOpt = input.test_param.options[0];
                if (Array.isArray(firstOpt)) {
                  // Array format: [label, value, selected]
                  const selectedOption = (input.test_param.options as unknown as Array<[string, string, boolean]>)
                    .find(o => o[1] === input.test_param!.value);
                  if (selectedOption) {
                    defaultToStore = selectedOption[0];
                  }
                } else {
                  const selectedOption = input.test_param.options.find(o => o.value === input.test_param!.value);
                  if (selectedOption) {
                    defaultToStore = selectedOption.label;
                  }
                }
              }
              defaults.set(testLabel, defaultToStore);
            }
          }

          // Recurse into nested inputs
          if (input.inputs) {
            extractDefaults(input.inputs as Array<{
              name: string;
              label?: string;
              title?: string;
              value?: unknown;
              type: string;
              options?: Array<{ value: string; label: string }>;
              inputs?: Array<unknown>;
              cases?: Array<{ inputs: Array<unknown> }>;
              test_param?: { label?: string; value?: unknown; options?: Array<{ value: string; label: string }> };
            }>);
          }

          // Recurse into conditional cases
          if (input.cases) {
            for (const caseItem of input.cases) {
              extractDefaults(caseItem.inputs as Array<{
                name: string;
                label?: string;
                title?: string;
                value?: unknown;
                type: string;
                options?: Array<{ value: string; label: string }>;
                inputs?: Array<unknown>;
                cases?: Array<{ inputs: Array<unknown> }>;
                test_param?: { label?: string; value?: unknown; options?: Array<{ value: string; label: string }> };
              }>);
            }
          }
        }
      };

      extractDefaults(schema.inputs as Array<{
        name: string;
        label?: string;
        title?: string;
        value?: unknown;
        type: string;
        options?: Array<{ value: string; label: string }>;
        inputs?: Array<unknown>;
        cases?: Array<{ inputs: Array<unknown> }>;
        test_param?: { label?: string; value?: unknown; options?: Array<{ value: string; label: string }> };
      }>);
    } catch (error) {
      console.warn(`Could not fetch schema defaults for ${toolId}`);
    }

    return defaults;
  }

  /**
   * Get schema defaults with full option information for accurate comparison
   */
  private async getSchemaDefaultsWithOptions(toolId: string): Promise<Map<string, {
    defaultLabel: unknown;
    defaultValue: unknown;
    options: Array<{ value: string; label: string }> | null;
  }>> {
    const result = new Map<string, {
      defaultLabel: unknown;
      defaultValue: unknown;
      options: Array<{ value: string; label: string }> | null;
    }>();

    if (!this.formMapper) return result;

    try {
      const schema = await this.formMapper.fetchToolFormSchema(toolId);

      type InputType = {
        name: string;
        label?: string;
        title?: string;
        value?: unknown;
        type: string;
        options?: Array<{ value: string; label: string }> | Array<[string, string, boolean]>;
        inputs?: Array<unknown>;
        cases?: Array<{ inputs: Array<unknown> }>;
        test_param?: {
          label?: string;
          value?: unknown;
          options?: Array<{ value: string; label: string }> | Array<[string, string, boolean]>;
        };
      };

      // Helper to normalize Galaxy's two option formats
      const normalizeOptions = (opts: Array<{ value: string; label: string }> | Array<[string, string, boolean]> | undefined): Array<{ value: string; label: string }> | null => {
        if (!opts || opts.length === 0) return null;
        if (Array.isArray(opts[0])) {
          // Array format: [label, value, selected]
          return (opts as Array<[string, string, boolean]>).map(o => ({ label: o[0], value: o[1] }));
        }
        return opts as Array<{ value: string; label: string }>;
      };

      const extractDefaults = (inputs: InputType[]) => {
        for (const input of inputs) {
          const fieldLabel = input.title || input.label || input.name;
          const options = normalizeOptions(input.options);

          if (input.value !== undefined) {
            let defaultLabel = input.value;
            const defaultValue = input.value;

            // For select fields, find the label for the default value
            if (input.type === 'select' && options && typeof input.value === 'string') {
              const selectedOption = options.find(o => o.value === input.value);
              if (selectedOption) {
                defaultLabel = selectedOption.label;
              }
            }

            result.set(fieldLabel, { defaultLabel, defaultValue, options });
          }

          // Handle conditional test_param
          if (input.type === 'conditional' && input.test_param) {
            const testLabel = input.test_param.label || input.name;
            const testOptions = normalizeOptions(input.test_param.options);

            if (input.test_param.value !== undefined) {
              let defaultLabel = input.test_param.value;
              const defaultValue = input.test_param.value;

              if (testOptions && typeof input.test_param.value === 'string') {
                const selectedOption = testOptions.find(o => o.value === input.test_param!.value);
                if (selectedOption) {
                  defaultLabel = selectedOption.label;
                }
              }

              result.set(testLabel, { defaultLabel, defaultValue, options: testOptions });
            }
          }

          // Recurse into nested inputs
          if (input.inputs) {
            extractDefaults(input.inputs as InputType[]);
          }

          // Recurse into conditional cases
          if (input.cases) {
            for (const caseItem of input.cases) {
              extractDefaults(caseItem.inputs as InputType[]);
            }
          }
        }
      };

      extractDefaults(schema.inputs as InputType[]);
    } catch (error) {
      console.warn(`Could not fetch schema defaults for ${toolId}`);
    }

    return result;
  }

  private formatToolParam(param: ToolParam, indent: number): string {
    const spaces = ' '.repeat(indent);
    let icon = '';

    // Add parameter icon if specified
    if (param.icon) {
      icon = `{% icon ${param.icon} %} `;
    }

    // Repeat sections use bold label, others use italic
    const isRepeat = param.icon === 'param-repeat';
    const label = isRepeat ? `**${param.label}**` : `*"${param.label}"*`;
    const value = isRepeat ? '' : `: \`${param.value}\``;

    let line = `${spaces}- ${icon}${label}${value}`;

    // Handle nested children (for repeat sections)
    if (param.children && param.children.length > 0) {
      const childLines = param.children.map(child =>
        this.formatToolParam(child, indent + 2)
      );
      line += '\n' + childLines.join('\n');
    }

    return line;
  }

  private async generateScreenshotStep(screenshot: ScreenshotStep): Promise<string> {
    // Execute pre-actions
    if (screenshot.pre_actions) {
      for (const action of screenshot.pre_actions) {
        switch (action.action) {
          case 'click':
            if (action.selector) await this.client.click(action.selector);
            break;
          case 'wait':
            await this.client.wait({ ms: action.ms, selector: action.selector });
            break;
          case 'set_param':
            if (action.selector && action.value) {
              await this.client.setParameter(action.selector, action.value);
            }
            break;
        }
      }
    }

    // Capture screenshot
    let imageBuffer = await this.client.captureScreenshot({
      selector: screenshot.selector,
      fullPage: screenshot.fullPage,
    });

    // Apply annotations
    if (screenshot.annotations && screenshot.annotations.length > 0) {
      // Map screenshot annotations to the Annotation type
      const annotations = screenshot.annotations.map((a) => {
        if (a.type === 'box') {
          return {
            type: 'box' as const,
            selector: a.selector || '',
            color: a.color,
            label: a.label,
          };
        } else if (a.type === 'arrow') {
          return {
            type: 'arrow' as const,
            from: a.from!,
            to: a.to!,
            color: a.color,
          };
        } else {
          return {
            type: 'text' as const,
            position: a.position!,
            text: a.text || '',
            color: a.color,
          };
        }
      });

      imageBuffer = await annotateImage(
        imageBuffer,
        annotations,
        async (selector) => this.client.getElementBounds(selector)
      );
    }

    // Save image
    this.images.push({
      filename: screenshot.filename,
      data: imageBuffer,
    });

    // Generate markdown - use relative path for GTN tutorials
    const imagePath = `images/${screenshot.filename}`;
    if (screenshot.caption) {
      return `![${screenshot.filename}](${imagePath} "${screenshot.caption}")`;
    }
    return `![${screenshot.filename}](${imagePath})`;
  }

  private generateNote(note: { title: string; type: string; text: string }): string {
    const blockType = note.type === 'comment' ? 'comment' : note.type;
    return `> <${blockType}-title>${note.title}</${blockType}-title>
> ${note.text}
{: .${blockType}}`;
  }

  private indentBlock(text: string, prefix: string): string {
    return text
      .split('\n')
      .map((line) => (line.trim() ? prefix + line : '>'))
      .join('\n');
  }
}
