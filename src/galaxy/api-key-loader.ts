import * as fs from 'fs';
import * as path from 'path';

export interface ApiKeys {
  galaxyApiKey?: string;
  anthropicApiKey?: string;
}

/**
 * Load API keys from .galaxy-api-key and .anthropic-api-key files in cwd
 */
export function loadApiKeys(dir?: string): ApiKeys {
  const baseDir = dir || process.cwd();
  const keys: ApiKeys = {};

  const galaxyKeyPath = path.join(baseDir, '.galaxy-api-key');
  if (fs.existsSync(galaxyKeyPath)) {
    const content = fs.readFileSync(galaxyKeyPath, 'utf-8').trim();
    if (content && !content.startsWith('#')) {
      keys.galaxyApiKey = content.split('\n')[0].trim();
    }
  }

  const anthropicKeyPath = path.join(baseDir, '.anthropic-api-key');
  if (fs.existsSync(anthropicKeyPath)) {
    const content = fs.readFileSync(anthropicKeyPath, 'utf-8').trim();
    if (content && !content.startsWith('#')) {
      keys.anthropicApiKey = content.split('\n')[0].trim();
    }
  }

  return keys;
}
