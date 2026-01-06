export interface HistoryDataset {
  id: string;
  name: string;
  extension: string;
  hid: number;
  file_size?: number;
  state: string;
  creating_job?: string;  // job ID that created this dataset
  tool_id?: string;       // tool that created this (resolved from job)
}

export interface HistoryCollection {
  id: string;
  name: string;
  hid: number;
  collection_type: string;  // 'list', 'paired', 'list:paired'
  element_count?: number;
  job_source_id?: string;
  job_source_type?: string;
}

export interface ExecutedJob {
  id: string;
  tool_id: string;
  state: string;
  create_time: string;
  update_time: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export interface HistoryDetails {
  id: string;
  name: string;
  annotation?: string;
  datasets: HistoryDataset[];
  collections: HistoryCollection[];
  jobs: ExecutedJob[];  // all jobs executed in this history
}

export interface CollectionElement {
  id: string;
  element_identifier: string;
  element_index: number;
  element_type: 'hda' | 'dataset_collection';
  object: {
    id: string;
    name: string;
    hid?: number;
  };
}

export class GalaxyHistoryClient {
  private galaxyUrl: string;
  private apiKey: string;

  constructor(galaxyUrl: string, apiKey: string) {
    this.galaxyUrl = galaxyUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Parse history URL to extract history ID and Galaxy URL
   * Supports formats:
   * - https://usegalaxy.org/histories/view?id=abc123
   * - https://usegalaxy.org/u/user/h/history-name
   * - https://usegalaxy.org/history/view/abc123
   */
  parseHistoryUrl(url: string): { historyId?: string; galaxyUrl: string; published?: { username: string; slug: string } } {
    const urlObj = new URL(url);
    const galaxyUrl = `${urlObj.protocol}//${urlObj.host}`;

    // Format: /histories/view?id=abc123
    const idParam = urlObj.searchParams.get('id');
    if (idParam) {
      return { historyId: idParam, galaxyUrl };
    }

    // Format: /history/view/abc123
    const viewMatch = urlObj.pathname.match(/\/history\/view\/([^/]+)/);
    if (viewMatch) {
      return { historyId: viewMatch[1], galaxyUrl };
    }

    // Format: /u/user/h/history-name (published history)
    const publishedMatch = urlObj.pathname.match(/\/u\/([^/]+)\/h\/([^/]+)/);
    if (publishedMatch) {
      return { galaxyUrl, published: { username: publishedMatch[1], slug: publishedMatch[2] } };
    }

    throw new Error(`Cannot parse history URL: ${url}`);
  }

  /**
   * Resolve a published history URL to get the history ID
   */
  async resolvePublishedHistory(username: string, slug: string): Promise<string> {
    // Galaxy API: get published histories for user, then find by slug
    // Try the published histories endpoint
    try {
      const response = await this.fetchApi(
        `/api/histories/published?slug=${encodeURIComponent(slug)}`
      ) as Array<Record<string, unknown>>;

      // Find the history matching username and slug
      const history = response.find(h =>
        String(h.slug) === slug &&
        (String(h.username) === username || String((h.user as Record<string, unknown>)?.username) === username)
      );

      if (history) {
        return String(history.id);
      }
    } catch {
      // Try alternative: direct slug lookup
    }

    // Alternative: try to access the history page directly and extract ID
    // Galaxy usually redirects /u/user/h/slug to the actual history with ID
    try {
      const response = await fetch(`${this.galaxyUrl}/u/${username}/h/${slug}`, {
        redirect: 'manual',
        headers: { 'x-api-key': this.apiKey },
      });

      // Check for redirect or extract ID from response
      const location = response.headers.get('location');
      if (location) {
        const idMatch = location.match(/[?&]id=([^&]+)/);
        if (idMatch) {
          return idMatch[1];
        }
      }
    } catch {
      // Ignore fetch errors
    }

    throw new Error(`Published history not found: ${username}/${slug}. Try using direct history ID URL format.`);
  }

  /**
   * Get history details including contents, collections, and jobs
   */
  async getHistory(historyId: string): Promise<HistoryDetails> {
    const [historyInfoRaw, contents, collections, jobs] = await Promise.all([
      this.fetchApi(`/api/histories/${historyId}`),
      this.getHistoryContents(historyId),
      this.getHistoryCollections(historyId),
      this.getHistoryJobs(historyId),
    ]);

    const historyInfo = historyInfoRaw as Record<string, unknown>;
    return {
      id: String(historyInfo.id),
      name: String(historyInfo.name),
      annotation: historyInfo.annotation ? String(historyInfo.annotation) : undefined,
      datasets: contents,
      collections,
      jobs,
    };
  }

  /**
   * Get datasets in a history with provenance info
   */
  async getHistoryContents(historyId: string): Promise<HistoryDataset[]> {
    const contents = await this.fetchApi(
      `/api/histories/${historyId}/contents?deleted=false&visible=true&details=all`
    ) as Array<Record<string, unknown>>;

    const datasets = contents
      .filter((item) => item.history_content_type === 'dataset')
      .map((item) => ({
        id: String(item.id),
        name: String(item.name),
        extension: String(item.extension),
        hid: Number(item.hid),
        file_size: item.file_size ? Number(item.file_size) : undefined,
        state: String(item.state),
        creating_job: item.creating_job ? String(item.creating_job) : undefined,
      }))
      .sort((a, b) => a.hid - b.hid);

    return datasets;
  }

  /**
   * Get collections in a history
   */
  async getHistoryCollections(historyId: string): Promise<HistoryCollection[]> {
    const contents = await this.fetchApi(
      `/api/histories/${historyId}/contents?deleted=false&visible=true&types=dataset_collection`
    ) as Array<Record<string, unknown>>;

    return contents
      .map((item) => ({
        id: String(item.id),
        name: String(item.name),
        hid: Number(item.hid),
        collection_type: String(item.collection_type || ''),
        element_count: item.element_count ? Number(item.element_count) : undefined,
        job_source_id: item.job_source_id ? String(item.job_source_id) : undefined,
        job_source_type: item.job_source_type ? String(item.job_source_type) : undefined,
      }))
      .sort((a, b) => a.hid - b.hid);
  }

  /**
   * Resolve a dataset collection element (DCE) ID to its parent collection
   * When tools run on collections, inputs show DCE IDs, not collection IDs
   */
  async resolveCollectionFromDce(historyId: string, dceId: string): Promise<HistoryCollection | undefined> {
    // Get all collections in history
    const collections = await this.getHistoryCollections(historyId);

    // For each collection, check if it contains this DCE
    for (const collection of collections) {
      try {
        const details = await this.fetchApi(
          `/api/histories/${historyId}/contents/${collection.id}?view=element`
        ) as Record<string, unknown>;

        const elements = (details.elements || []) as Array<Record<string, unknown>>;
        const found = this.findDceInElements(elements, dceId);
        if (found) {
          return collection;
        }
      } catch {
        // Skip collection if can't fetch details
      }
    }

    return undefined;
  }

  /**
   * Recursively search for DCE ID in collection elements (handles nested collections)
   */
  private findDceInElements(elements: Array<Record<string, unknown>>, dceId: string): boolean {
    for (const element of elements) {
      if (String(element.id) === dceId) {
        return true;
      }
      // Check nested collections (for list:paired, etc.)
      const obj = element.object as Record<string, unknown> | undefined;
      if (obj?.elements) {
        if (this.findDceInElements(obj.elements as Array<Record<string, unknown>>, dceId)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Build a map of DCE ID -> parent collection for all collections in history
   * More efficient than resolving one at a time
   */
  async buildDceToCollectionMap(historyId: string): Promise<Map<string, HistoryCollection>> {
    const collections = await this.getHistoryCollections(historyId);
    const dceMap = new Map<string, HistoryCollection>();

    for (const collection of collections) {
      try {
        const details = await this.fetchApi(
          `/api/histories/${historyId}/contents/${collection.id}?view=element`
        ) as Record<string, unknown>;

        const elements = (details.elements || []) as Array<Record<string, unknown>>;
        this.collectDceIds(elements, collection, dceMap);
      } catch {
        // Skip collection if can't fetch details
      }
    }

    return dceMap;
  }

  /**
   * Recursively collect all DCE IDs from collection elements
   */
  private collectDceIds(
    elements: Array<Record<string, unknown>>,
    parentCollection: HistoryCollection,
    dceMap: Map<string, HistoryCollection>
  ): void {
    for (const element of elements) {
      dceMap.set(String(element.id), parentCollection);
      // Handle nested collections
      const obj = element.object as Record<string, unknown> | undefined;
      if (obj?.elements) {
        this.collectDceIds(obj.elements as Array<Record<string, unknown>>, parentCollection, dceMap);
      }
    }
  }

  /**
   * Group jobs by tool_id and return first job of each group
   * Used for deduplication when tools run on collection elements
   */
  groupJobsByTool(jobs: ExecutedJob[]): ExecutedJob[] {
    const toolJobMap = new Map<string, ExecutedJob>();

    for (const job of jobs) {
      // Use first occurrence of each tool
      if (!toolJobMap.has(job.tool_id)) {
        toolJobMap.set(job.tool_id, job);
      }
    }

    // Return in original order (by create_time since jobs are pre-sorted)
    return Array.from(toolJobMap.values());
  }

  /**
   * Get all jobs executed in a history
   */
  async getHistoryJobs(historyId: string): Promise<ExecutedJob[]> {
    const jobs = await this.fetchApi(
      `/api/jobs?history_id=${historyId}&order_by=create_time`
    ) as Array<Record<string, unknown>>;

    // Filter out skipped jobs and internal workflow tools
    const internalTools = new Set([
      '__MERGE_COLLECTION__', '__RELABEL_FROM_FILE__', '__FLATTEN__',
      '__FILTER_FAILED_DATASETS__', '__FILTER_EMPTY_DATASETS__',
      '__UNZIP_COLLECTION__', '__ZIP_COLLECTION__', '__BUILD_LIST__',
      'param_value_from_file',
    ]);

    // Helper tools that are workflow infrastructure, not user-facing
    const helperToolPatterns = [
      /^map_param_value/,
      /^pick_value/,
      /^compose_text_param/,
    ];

    return jobs
      .filter(j => {
        const toolId = String(j.tool_id);
        const state = String(j.state);
        // Skip skipped/failed jobs
        if (state === 'skipped' || state === 'error') return false;
        // Skip internal tools
        if (internalTools.has(toolId)) return false;
        if (toolId.startsWith('__')) return false;
        // Skip helper tools
        for (const pattern of helperToolPatterns) {
          if (pattern.test(toolId) || toolId.includes('/map_param_value/') ||
              toolId.includes('/pick_value/') || toolId.includes('/compose_text_param/')) {
            return false;
          }
        }
        return true;
      })
      .map(j => ({
        id: String(j.id),
        tool_id: String(j.tool_id),
        state: String(j.state),
        create_time: String(j.create_time),
        update_time: String(j.update_time),
        inputs: (j.inputs || {}) as Record<string, unknown>,
        outputs: (j.outputs || {}) as Record<string, unknown>,
      }));
  }

  /**
   * Get job details to find tool_id
   */
  async getJobDetails(jobId: string): Promise<{ tool_id: string; inputs: Record<string, unknown> }> {
    const job = await this.fetchApi(`/api/jobs/${jobId}`) as Record<string, unknown>;
    return {
      tool_id: String(job.tool_id),
      inputs: (job.inputs || {}) as Record<string, unknown>,
    };
  }

  /**
   * Resolve tool_ids for all datasets by fetching job details
   */
  async resolveToolIds(datasets: HistoryDataset[]): Promise<HistoryDataset[]> {
    // Get unique job IDs
    const jobIds = [...new Set(datasets.map(d => d.creating_job).filter(Boolean))] as string[];

    // Fetch job details in parallel (batch of 10 to avoid rate limiting)
    const jobMap = new Map<string, string>();
    for (let i = 0; i < jobIds.length; i += 10) {
      const batch = jobIds.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (jobId) => {
          try {
            const job = await this.getJobDetails(jobId);
            return { jobId, toolId: job.tool_id };
          } catch {
            return { jobId, toolId: undefined };
          }
        })
      );
      for (const { jobId, toolId } of results) {
        if (toolId) jobMap.set(jobId, toolId);
      }
    }

    // Attach tool_id to datasets
    return datasets.map(d => ({
      ...d,
      tool_id: d.creating_job ? jobMap.get(d.creating_job) : undefined,
    }));
  }

  /**
   * Fetch history from URL (parse + fetch), resolving published URLs and tool IDs
   */
  async fetchHistoryFromUrl(historyUrl: string): Promise<HistoryDetails> {
    const parsed = this.parseHistoryUrl(historyUrl);

    // Update galaxyUrl if different from constructor
    if (parsed.galaxyUrl !== this.galaxyUrl) {
      this.galaxyUrl = parsed.galaxyUrl;
    }

    // Resolve published history URL to ID
    let historyId: string;
    if (parsed.historyId) {
      historyId = parsed.historyId;
    } else if (parsed.published) {
      console.log(`  Resolving published history: ${parsed.published.username}/${parsed.published.slug}`);
      historyId = await this.resolvePublishedHistory(parsed.published.username, parsed.published.slug);
    } else {
      throw new Error('Could not determine history ID from URL');
    }

    // Fetch history with jobs
    const history = await this.getHistory(historyId);
    console.log(`  Found ${history.datasets.length} datasets, ${history.collections.length} collections, ${history.jobs.length} executed tool jobs`);

    return history;
  }

  private async fetchApi(endpoint: string): Promise<unknown> {
    const response = await fetch(`${this.galaxyUrl}${endpoint}`, {
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Galaxy API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }
}
