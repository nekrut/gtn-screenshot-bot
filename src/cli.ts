#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { stringify as stringifyYaml } from 'yaml';
import { TutorialGenerator } from './tutorial/generator';
import { HistoryConverter } from './tutorial/history-converter';
import { loadApiKeys } from './galaxy/api-key-loader';

const program = new Command();

program
  .name('gtn-screenshots')
  .description('Generate GTN tutorials from Galaxy history URLs')
  .version('0.1.0');

program
  .command('from-history', { isDefault: true })
  .description('Generate tutorial from a Galaxy history URL')
  .requiredOption('-h, --history <url>', 'Galaxy history URL')
  .option('-o, --output <dir>', 'Output directory for tutorial', './output')
  .option('--images-dir <dir>', 'Images output directory', './output/images')
  .option('--title <title>', 'Tutorial title')
  .option('--url <url>', 'Galaxy URL (auto-detected from history URL)')
  .option('--api-key <key>', 'Galaxy API key (or use .galaxy-api-key file)')
  .option('--username <user>', 'Galaxy username (for full login)')
  .option('--password <pass>', 'Galaxy password (for full login)')
  .option('--anthropic-key <key>', 'Anthropic API key (or use .anthropic-api-key file)')
  .option('--generate', 'Generate full tutorial with screenshots')
  .option('--config-only', 'Only generate config YAML, skip tutorial generation')
  .action(async (options) => {
    try {
      await runFromHistory(options);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

async function runFromHistory(options: {
  history: string;
  output?: string;
  imagesDir?: string;
  title?: string;
  url?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  anthropicKey?: string;
  generate?: boolean;
  configOnly?: boolean;
}) {
  // Load API keys from files (CLI args override)
  const keys = loadApiKeys();
  const galaxyApiKey = options.apiKey || keys.galaxyApiKey;
  const anthropicApiKey = options.anthropicKey || keys.anthropicApiKey;

  if (!galaxyApiKey) {
    throw new Error('Galaxy API key required. Use --api-key or create .galaxy-api-key file');
  }

  if (options.username && options.password) {
    console.log(`Using Galaxy login: ${options.username}`);
  } else {
    console.log('Using Galaxy API key');
  }
  if (anthropicApiKey) {
    console.log('Using Anthropic API key');
  }

  // Extract Galaxy URL from history URL or use override
  let galaxyUrl = options.url;
  if (!galaxyUrl) {
    const urlObj = new URL(options.history);
    galaxyUrl = `${urlObj.protocol}//${urlObj.host}`;
  }

  const outputDir = options.output || './output';
  const imagesDir = options.imagesDir || path.join(outputDir, 'images');

  console.log(`\nHistory URL: ${options.history}`);
  console.log(`Galaxy URL: ${galaxyUrl}`);
  console.log(`Output: ${outputDir}`);

  // Convert history to tutorial config
  const converter = new HistoryConverter({
    galaxyUrl,
    apiKey: galaxyApiKey,
    historyUrl: options.history,
    outputDir,
    imagesDir,
    title: options.title,
  });

  const config = await converter.convert();

  // Add credentials if provided (for full login during screenshot generation)
  if (options.username && options.password) {
    config.galaxy.credentials = {
      username: options.username,
      password: options.password,
    };
  }

  // Save config YAML
  const configPath = path.join(outputDir, 'tutorial-config.yaml');
  fs.mkdirSync(outputDir, { recursive: true });
  const yamlContent = stringifyYaml(config);
  fs.writeFileSync(configPath, yamlContent);
  console.log(`\nConfig saved: ${configPath}`);

  // Generate full tutorial if requested
  if (options.generate && !options.configOnly) {
    console.log('\nGenerating tutorial with screenshots...');

    if (anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = anthropicApiKey;
    }

    const generator = new TutorialGenerator(config, {
      formMapper: converter.getFormMapper(),
      historyClient: converter.getHistoryClient(),
      jobParamsClient: converter.getJobParamsClient(),
    });
    await generator.save();

    console.log('\nTutorial generated successfully!');
    console.log(`Output: ${outputDir}/tutorial.md`);
    console.log(`Images: ${imagesDir}/`);
  } else {
    console.log('\nNext steps:');
    console.log('  Add --generate flag to create tutorial with screenshots');
  }
}

program.parse();
