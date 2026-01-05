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

export class TutorialGenerator {
  private config: TutorialConfig;
  private client: GalaxyClient;
  private ai: AIGenerator | null;
  private images: GeneratedImage[] = [];

  constructor(config: TutorialConfig) {
    this.config = config;
    this.client = new GalaxyClient(config.galaxy.url);
    this.ai = config.ai ? new AIGenerator(config.ai) : null;
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
        await this.client.openTool(tool.tool_id);
        toolOpened = true;

        // Select input datasets from history if specified
        if (tool.input_datasets && tool.input_datasets.length > 0) {
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
        const screenshotContent = await this.generateScreenshotStep(tool.screenshot);
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
