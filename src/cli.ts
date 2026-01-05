#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GalaxyClient } from './galaxy/client';
import { ScreenshotRunner } from './capture/screenshot';
import { ScreenshotConfig } from './config/types';
import { TutorialConfig } from './tutorial/types';
import { TutorialGenerator } from './tutorial/generator';
import { convertRecording } from './tutorial/recording-converter';
import { convertWorkflow } from './tutorial/workflow-converter';
import { loadApiKeys } from './galaxy/api-key-loader';

const program = new Command();

program
  .name('gtn-screenshots')
  .description('Automated screenshot and tutorial generation for Galaxy Training Network')
  .version('0.1.0');

// ============================================
// Screenshots command (default behavior)
// ============================================
program
  .command('screenshots')
  .description('Capture screenshots only')
  .requiredOption('-c, --config <path>', 'Path to screenshot config YAML file')
  .option('-u, --url <url>', 'Override Galaxy URL from config')
  .option('-i, --id <id>', 'Capture only screenshot with this ID')
  .option('-o, --output <dir>', 'Override output directory')
  .option('--username <username>', 'Galaxy username for login')
  .option('--password <password>', 'Galaxy password for login')
  .option('--api-key <key>', 'Galaxy API key for authentication')
  .action(async (options) => {
    try {
      await runScreenshots(options);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// ============================================
// Generate command (full tutorial)
// ============================================
program
  .command('generate')
  .description('Generate a complete GTN tutorial with screenshots')
  .requiredOption('-c, --config <path>', 'Path to tutorial config YAML file')
  .option('-u, --url <url>', 'Override Galaxy URL from config')
  .option('--username <username>', 'Galaxy username for login')
  .option('--password <password>', 'Galaxy password for login')
  .option('--api-key <key>', 'Galaxy API key for authentication')
  .option('--anthropic-key <key>', 'Anthropic API key for AI generation')
  .option('--openai-key <key>', 'OpenAI API key for AI generation')
  .action(async (options) => {
    try {
      await runGenerate(options);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// ============================================
// Convert command (DevTools recording)
// ============================================
program
  .command('convert')
  .description('Convert a Chrome DevTools recording to tutorial config')
  .requiredOption('-i, --input <path>', 'Path to DevTools recording JSON file')
  .requiredOption('-o, --output <path>', 'Output path for YAML config')
  .requiredOption('--url <url>', 'Galaxy URL')
  .option('--title <title>', 'Tutorial title')
  .option('--screenshots', 'Add screenshot steps after significant actions')
  .option('--output-dir <dir>', 'Output directory for tutorial', './output')
  .option('--images-dir <dir>', 'Output directory for images', './output/images')
  .action(async (options) => {
    try {
      await runConvert(options);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// ============================================
// From-workflow command (convert Galaxy workflow to tutorial)
// ============================================
program
  .command('from-workflow')
  .description('Generate tutorial from a Galaxy workflow file')
  .requiredOption('-w, --workflow <path>', 'Path to Galaxy workflow (.ga) file')
  .requiredOption('-o, --output <path>', 'Output path for generated config YAML')
  .option('-h, --history <url>', 'Galaxy history URL with input datasets')
  .option('--topic <name>', 'Topic name for planemo', 'introduction')
  .option('--tutorial <name>', 'Tutorial name for planemo', 'my-tutorial')
  .option('--title <title>', 'Tutorial title')
  .option('--url <url>', 'Galaxy URL', 'https://usegalaxy.org')
  .option('--api-key <key>', 'Galaxy API key (or use .galaxy-api-key file)')
  .option('--use-planemo', 'Use planemo to generate skeleton (requires planemo installed)')
  .option('--training-material <path>', 'Path to training-material repo (for planemo)')
  .option('--output-dir <dir>', 'Tutorial output directory', './output')
  .option('--images-dir <dir>', 'Images output directory', './output/images')
  .option('--generate', 'Also generate the tutorial (not just config)')
  .option('--anthropic-key <key>', 'Anthropic API key (or use .anthropic-api-key file)')
  .action(async (options) => {
    try {
      await runFromWorkflow(options);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// ============================================
// Init command (create template config)
// ============================================
program
  .command('init')
  .description('Create a template tutorial config file')
  .option('-o, --output <path>', 'Output path for config', './tutorial-config.yaml')
  .option('--type <type>', 'Config type: screenshots or tutorial', 'tutorial')
  .action(async (options) => {
    try {
      await runInit(options);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// ============================================
// Implementation functions
// ============================================

async function runScreenshots(options: {
  config: string;
  url?: string;
  id?: string;
  output?: string;
  username?: string;
  password?: string;
  apiKey?: string;
}) {
  const configPath = path.resolve(options.config);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config: ScreenshotConfig = parseYaml(configContent);

  const galaxyUrl = options.url || config.galaxy_url;
  const outputDir = options.output || config.output_dir;
  const username = options.username || config.credentials?.username;
  const password = options.password || config.credentials?.password;
  const apiKey = options.apiKey || config.api_key;

  if (!galaxyUrl) {
    throw new Error('Galaxy URL is required (in config or via --url)');
  }

  console.log(`Galaxy URL: ${galaxyUrl}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Screenshots to capture: ${options.id || 'all'}\n`);

  const client = new GalaxyClient(galaxyUrl);
  await client.init();

  try {
    if (username && password) {
      console.log(`Logging in as ${username}...`);
      await client.login(username, password);
    } else if (apiKey) {
      console.log('Authenticating with API key...');
      await client.loginWithApiKey(apiKey);
    } else {
      console.log('Running without authentication (anonymous access)');
      await client.navigate();
    }

    const runner = new ScreenshotRunner(client, outputDir);

    let screenshots = config.screenshots;
    if (options.id) {
      screenshots = screenshots.filter((s) => s.id === options.id);
      if (screenshots.length === 0) {
        throw new Error(`Screenshot with ID "${options.id}" not found in config`);
      }
    }

    console.log(`\nCapturing ${screenshots.length} screenshot(s)...\n`);

    for (const screenshot of screenshots) {
      try {
        await runner.runScreenshot(screenshot);
      } catch (error) {
        console.error(`  Error capturing ${screenshot.id}:`, error);
      }
    }

    console.log('\nDone!');
  } finally {
    await client.close();
  }
}

async function runGenerate(options: {
  config: string;
  url?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  anthropicKey?: string;
  openaiKey?: string;
}) {
  const configPath = path.resolve(options.config);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config: TutorialConfig = parseYaml(configContent);

  // Apply overrides
  if (options.url) {
    config.galaxy.url = options.url;
  }
  if (options.username && options.password) {
    config.galaxy.credentials = {
      username: options.username,
      password: options.password,
    };
  }
  if (options.apiKey) {
    config.galaxy.api_key = options.apiKey;
  }

  // Set AI API keys from CLI or environment
  if (options.anthropicKey) {
    process.env.ANTHROPIC_API_KEY = options.anthropicKey;
  }
  if (options.openaiKey) {
    process.env.OPENAI_API_KEY = options.openaiKey;
  }

  console.log(`Generating tutorial: ${config.metadata.title}`);
  console.log(`Galaxy URL: ${config.galaxy.url}`);
  console.log(`Output: ${config.output.tutorial_dir}\n`);

  const generator = new TutorialGenerator(config);
  await generator.save();

  console.log('\nTutorial generated successfully!');
}

async function runConvert(options: {
  input: string;
  output: string;
  url: string;
  title?: string;
  screenshots?: boolean;
  outputDir?: string;
  imagesDir?: string;
}) {
  const inputPath = path.resolve(options.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Recording file not found: ${inputPath}`);
  }

  console.log(`Converting recording: ${inputPath}`);

  const config = convertRecording(inputPath, {
    galaxyUrl: options.url,
    metadata: {
      title: options.title,
    },
    outputDir: options.outputDir || './output',
    imagesDir: options.imagesDir || './output/images',
    addScreenshots: options.screenshots,
  });

  const outputPath = path.resolve(options.output);
  const yamlContent = stringifyYaml(config);
  fs.writeFileSync(outputPath, yamlContent);

  console.log(`Config saved: ${outputPath}`);
  console.log('\nNext steps:');
  console.log('1. Edit the config to add section titles and annotations');
  console.log('2. Run: gtn-screenshots generate --config ' + options.output);
}

async function runInit(options: { output: string; type: string }) {
  const outputPath = path.resolve(options.output);

  let template: string;

  if (options.type === 'screenshots') {
    template = `# Screenshot-only configuration
galaxy_url: https://usegalaxy.org
output_dir: ./screenshots

screenshots:
  - id: example
    description: "Example screenshot"
    output: example.png
    steps:
      - action: open_tool
        tool_id: toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0+galaxy4
      - action: wait
        ms: 2000
      - action: capture
        selector: ".tool-form"
        annotations:
          - type: box
            selector: '[data-label="Input"]'
            color: red
`;
  } else {
    template = `# Full tutorial configuration
# GTN format: https://training.galaxyproject.org/training-material/topics/contributing/tutorials/create-new-tutorial-content/tutorial.html

metadata:
  title: "My Galaxy Tutorial"
  questions:
    - "What will you learn in this tutorial?"
  objectives:
    - "Learn to use Galaxy tools for data analysis"
  level: Introductory
  time_estimation: "1H"
  contributions:
    authorship:
      - your-github-username
  # Abbreviations auto-expand on first use with {ABBREV} syntax
  abbreviations:
    QC: Quality Control
    NGS: Next-Generation Sequencing

galaxy:
  url: https://usegalaxy.org
  # credentials:
  #   username: your_username
  #   password: your_password

ai:
  provider: anthropic
  generate_explanations: true
  generate_key_points: true

output:
  tutorial_dir: ./output
  images_dir: ./output/images

sections:
  - id: intro
    title: "Introduction"
    level: 1
    type: intro
    content:
      - type: text
        generate: true
        prompt: "Write an introduction explaining the goal of this analysis"

  - id: upload-data
    title: "Upload data into Galaxy"
    level: 2
    type: hands_on
    details_blocks:
      - title: "What is FASTQ data?"
        generate: true
        topic: "FASTQ file format and quality scores"
    steps:
      - type: instruction
        text: "Go to your Galaxy instance"
      - type: tool_run
        tool:
          tool_id: upload1
          name: Upload Data
          params:
            - label: "File source"
              value: "Paste/Fetch"
              icon: param-select  # Available: param-text, param-file, param-files, param-select, param-check, param-toggle, param-repeat
          screenshot:
            filename: upload.png
            selector: ".upload-dialog"
    content:
      # Example tip box
      - type: tip
        title: "Importing data via links"
        text: "You can paste URLs directly into the upload dialog to fetch data from the web."

  - id: run-fastp
    title: "Quality control with fastp"
    level: 2
    type: hands_on
    steps:
      - type: tool_run
        tool:
          tool_id: toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0+galaxy4
          name: fastp
          params:
            - label: "Single-end or paired reads"
              value: "Paired collection"
              icon: param-select
              annotation:
                color: red
                type: outline
            - label: "Input file"
              value: "your_reads.fastq"
              icon: param-file
          screenshot:
            filename: fastp.png
            selector: ".tool-form"
            annotations:
              - type: box
                selector: '[data-label*="Single-end"]'
                color: red
    content:
      # Example question box
      - type: question
        questions:
          - "What quality score encoding does your data use?"
          - "Why is adapter trimming important?"
        solution:
          answers:
            - "Most modern Illumina data uses Phred+33 encoding"
            - "Adapter sequences can interfere with alignment and cause false results"

  - id: conclusion
    title: "Conclusion"
    level: 1
    type: conclusion
    content:
      - type: text
        generate: true
        prompt: "Summarize what was learned in this tutorial"
`;
  }

  fs.writeFileSync(outputPath, template);
  console.log(`Template config created: ${outputPath}`);
  console.log(`\nEdit the config, then run:`);

  if (options.type === 'screenshots') {
    console.log(`  gtn-screenshots screenshots --config ${options.output}`);
  } else {
    console.log(`  gtn-screenshots generate --config ${options.output}`);
  }
}

async function runFromWorkflow(options: {
  workflow: string;
  output: string;
  history?: string;
  topic?: string;
  tutorial?: string;
  title?: string;
  url?: string;
  apiKey?: string;
  usePlanemo?: boolean;
  trainingMaterial?: string;
  outputDir?: string;
  imagesDir?: string;
  generate?: boolean;
  anthropicKey?: string;
}) {
  const workflowPath = path.resolve(options.workflow);
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow file not found: ${workflowPath}`);
  }

  // Load API keys from files (CLI args override)
  const keys = loadApiKeys();
  const galaxyApiKey = options.apiKey || keys.galaxyApiKey;
  const anthropicApiKey = options.anthropicKey || keys.anthropicApiKey;

  if (galaxyApiKey) {
    console.log('Using Galaxy API key');
  }
  if (anthropicApiKey) {
    console.log('Using Anthropic API key');
  }

  console.log(`Converting workflow: ${workflowPath}`);
  if (options.history) {
    console.log(`Using history: ${options.history}`);
  }

  const config = await convertWorkflow({
    workflowPath,
    topicName: options.topic || 'introduction',
    tutorialName: options.tutorial || 'my-tutorial',
    galaxyUrl: options.url,
    galaxyApiKey,
    historyUrl: options.history,
    outputDir: options.outputDir || './output',
    imagesDir: options.imagesDir || './output/images',
    usePlanemo: options.usePlanemo,
    trainingMaterialPath: options.trainingMaterial,
    metadata: options.title ? { title: options.title } : undefined,
  });

  // Save config YAML
  const outputPath = path.resolve(options.output);
  const yamlContent = stringifyYaml(config);
  fs.writeFileSync(outputPath, yamlContent);

  console.log(`Config saved: ${outputPath}`);

  // Optionally generate the full tutorial
  if (options.generate) {
    console.log('\nGenerating tutorial...');

    if (anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = anthropicApiKey;
    }

    const { TutorialGenerator } = await import('./tutorial/generator');
    const generator = new TutorialGenerator(config);
    await generator.save();

    console.log('Tutorial generated successfully!');
  } else {
    console.log('\nNext steps:');
    console.log('1. Edit the config to customize sections and annotations');
    console.log('2. Run: gtn-screenshots generate --config ' + options.output);
  }
}

// Default command (screenshots) when no subcommand given
if (process.argv.length > 2 && !['screenshots', 'generate', 'convert', 'from-workflow', 'init', 'help', '-h', '--help', '-V', '--version'].includes(process.argv[2])) {
  // Insert 'screenshots' as default command
  process.argv.splice(2, 0, 'screenshots');
}

program.parse();
