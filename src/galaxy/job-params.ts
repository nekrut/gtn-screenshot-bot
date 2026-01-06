/**
 * Job parameter extraction and parsing for Galaxy jobs.
 * Fetches full job details and parses the JSON-stringified parameters.
 */

export interface ParsedParam {
  name: string;
  value: unknown;
  rawValue: string;
  isCollection: boolean;  // src === "dce" (dataset collection element)
  isDataset: boolean;     // src === "hda" or "ldda"
}

export interface InputRef {
  src: 'hda' | 'ldda' | 'hdca' | 'dce';  // dataset, library, collection, collection element
  id: string;
  name?: string;  // resolved from history contents
  hid?: number;   // history item ID
}

export interface JobFullParams {
  jobId: string;
  toolId: string;
  toolVersion: string;
  toolName: string;
  createTime: string;
  state: string;
  params: Record<string, ParsedParam>;
  inputs: Record<string, InputRef>;
  outputs: Record<string, unknown>;
  commandLine?: string;
}

/**
 * Recursively search for src references in nested objects
 */
function findSrcReferences(obj: unknown): { hasCollection: boolean; hasDataset: boolean } {
  let hasCollection = false;
  let hasDataset = false;

  if (typeof obj !== 'object' || obj === null) {
    return { hasCollection, hasDataset };
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findSrcReferences(item);
      hasCollection = hasCollection || result.hasCollection;
      hasDataset = hasDataset || result.hasDataset;
    }
    return { hasCollection, hasDataset };
  }

  const record = obj as Record<string, unknown>;

  // Check for src field
  if (record.src) {
    hasCollection = record.src === 'dce' || record.src === 'hdca';
    hasDataset = record.src === 'hda' || record.src === 'ldda';
  }

  // Recurse into all properties
  for (const value of Object.values(record)) {
    const result = findSrcReferences(value);
    hasCollection = hasCollection || result.hasCollection;
    hasDataset = hasDataset || result.hasDataset;
  }

  return { hasCollection, hasDataset };
}

/**
 * Parse a JSON-stringified param value from Galaxy job API
 */
export function parseParamValue(rawValue: string): { value: unknown; isCollection: boolean; isDataset: boolean } {
  let value: unknown;
  let isCollection = false;
  let isDataset = false;

  try {
    value = JSON.parse(rawValue);

    // Recursively search for src references
    const refs = findSrcReferences(value);
    isCollection = refs.hasCollection;
    isDataset = refs.hasDataset;
  } catch {
    // Not valid JSON, use as-is
    value = rawValue;
  }

  return { value, isCollection, isDataset };
}

/**
 * Parse all job params from raw API response
 */
export function parseJobParams(rawParams: Record<string, string>): Record<string, ParsedParam> {
  const parsed: Record<string, ParsedParam> = {};

  for (const [name, rawValue] of Object.entries(rawParams)) {
    // Skip internal Galaxy params
    if (name.startsWith('__') || name === 'chromInfo' || name === 'dbkey') {
      continue;
    }

    const { value, isCollection, isDataset } = parseParamValue(rawValue);

    parsed[name] = {
      name,
      value,
      rawValue,
      isCollection,
      isDataset,
    };
  }

  return parsed;
}

/**
 * Extract the display value for a param (for tutorial text)
 */
export function getDisplayValue(param: ParsedParam): string {
  const { value } = param;

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Dataset/collection reference - return placeholder, will be resolved later
    if (obj.src) {
      return `[Dataset ${obj.id}]`;
    }

    // Nested values
    if (Array.isArray(obj.values) && obj.values.length > 0) {
      const first = obj.values[0] as Record<string, unknown>;
      if (first.src) {
        return `[Collection element]`;
      }
    }

    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Dataset input reference from parameters_display API
 */
export interface DatasetInputRef {
  id: string;
  src: 'hda' | 'hdca';
  hid: number;
  name: string;
}

/**
 * Galaxy History Client extension for fetching full job params
 */
export class JobParamsClient {
  private galaxyUrl: string;
  private apiKey: string;

  constructor(galaxyUrl: string, apiKey: string) {
    this.galaxyUrl = galaxyUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Fetch full job details including params
   */
  async fetchJobFullParams(jobId: string): Promise<JobFullParams> {
    const response = await fetch(`${this.galaxyUrl}/api/jobs/${jobId}?full=true`, {
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch job ${jobId}: ${response.status} ${response.statusText}`);
    }

    const job = await response.json() as Record<string, unknown>;

    // Parse raw params
    const rawParams = (job.params || {}) as Record<string, string>;
    const params = parseJobParams(rawParams);

    // Parse inputs
    const rawInputs = (job.inputs || {}) as Record<string, Record<string, unknown>>;
    const inputs: Record<string, InputRef> = {};
    for (const [name, ref] of Object.entries(rawInputs)) {
      inputs[name] = {
        src: ref.src as InputRef['src'],
        id: String(ref.id),
      };
    }

    // Extract tool name from tool_id
    const toolId = String(job.tool_id);
    const toolName = this.extractToolName(toolId);

    return {
      jobId: String(job.id),
      toolId,
      toolVersion: String(job.tool_version || ''),
      toolName,
      createTime: String(job.create_time),
      state: String(job.state),
      params,
      inputs,
      outputs: (job.outputs || {}) as Record<string, unknown>,
      commandLine: job.command_line ? String(job.command_line) : undefined,
    };
  }

  /**
   * Extract human-readable tool name from tool_id
   */
  private extractToolName(toolId: string): string {
    // toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0 -> fastp
    const parts = toolId.split('/');
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return toolId;
  }

  /**
   * Fetch input collections from dataset parameters_display API
   * This works for single-dataset outputs and shows actual collection inputs
   */
  async fetchDatasetInputCollections(datasetId: string): Promise<DatasetInputRef[]> {
    const response = await fetch(`${this.galaxyUrl}/api/datasets/${datasetId}/parameters_display`, {
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch dataset params for ${datasetId}: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const collections: DatasetInputRef[] = [];

    // Recursively search for hdca references in the response
    const findHdcaRefs = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') return;

      if (Array.isArray(obj)) {
        for (const item of obj) {
          findHdcaRefs(item);
        }
        return;
      }

      const record = obj as Record<string, unknown>;

      // Check if this object is an hdca reference
      if (record.src === 'hdca' && record.hid !== undefined && record.name) {
        collections.push({
          id: String(record.id || ''),
          src: 'hdca',
          hid: Number(record.hid),
          name: String(record.name),
        });
        return;
      }

      // Recurse into nested objects
      for (const value of Object.values(record)) {
        findHdcaRefs(value);
      }
    };

    findHdcaRefs(data);
    return collections;
  }

  /**
   * Flattened parameter from parameters_display API
   */
  /**
   * Fetch flattened parameters_display from job API
   * Returns human-readable labels with actual values
   */
  async fetchJobParametersDisplay(jobId: string): Promise<Array<{
    text: string;      // Human-readable label
    depth: number;     // Nesting level
    value: unknown;    // Actual value
    notes: string | null;
  }>> {
    const response = await fetch(`${this.galaxyUrl}/api/jobs/${jobId}/parameters_display`, {
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch job parameters_display for ${jobId}: ${response.status}`);
      return [];
    }

    const data = await response.json() as { parameters: Array<{
      text: string;
      depth: number;
      value: unknown;
      notes: string | null;
    }> };

    return data.parameters || [];
  }

  /**
   * Fetch params for multiple jobs in batches
   */
  async fetchAllJobParams(jobIds: string[], batchSize = 5): Promise<JobFullParams[]> {
    const results: JobFullParams[] = [];

    for (let i = 0; i < jobIds.length; i += batchSize) {
      const batch = jobIds.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(id => this.fetchJobFullParams(id).catch(err => {
          console.warn(`Failed to fetch job ${id}:`, err.message);
          return null;
        }))
      );

      results.push(...batchResults.filter((r): r is JobFullParams => r !== null));

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < jobIds.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    return results;
  }
}
