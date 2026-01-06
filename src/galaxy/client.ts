import { Browser, Page, chromium } from 'playwright';
import { ElementBounds } from '../tutorial/types';
import { JobFullParams, ParsedParam } from './job-params';
import { FormMapper, FormFieldMapping } from './form-mapper';

export class GalaxyClient {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private baseUrl: string;
  private apiKey: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async init(options?: { headless?: boolean }): Promise<void> {
    this.browser = await chromium.launch({
      headless: options?.headless ?? true,
    });
    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await context.newPage();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Galaxy client not initialized. Call init() first.');
    }
    return this.page;
  }

  async navigate(path: string = ''): Promise<void> {
    const page = this.getPage();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    await page.goto(url);
    await this.waitForGalaxyReady();
  }

  async waitForGalaxyReady(): Promise<void> {
    const page = this.getPage();
    // Wait for Galaxy's main UI to be ready
    await page.waitForSelector('#center, .center-container, [data-description="center panel"]', {
      timeout: 30000,
    });
    // Additional wait for dynamic content
    await page.waitForTimeout(1000);
  }

  async login(username: string, password: string): Promise<void> {
    const page = this.getPage();
    console.log('  Logging in...');

    // Navigate to login page directly (don't use navigate() which waits for center panel)
    await page.goto(`${this.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Fill login form - Galaxy uses specific input names
    await page.fill('input[name="login"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // Wait for redirect to main Galaxy page after login
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 });
    await this.waitForGalaxyReady();
    console.log('  Logged in successfully');
  }

  async loginWithApiKey(apiKey: string): Promise<void> {
    const page = this.getPage();
    this.apiKey = apiKey;  // Store for later use in URLs

    // Navigate to Galaxy first
    await page.goto(this.baseUrl, { waitUntil: 'networkidle' });

    // Set API key in sessionStorage (Galaxy checks this)
    await page.evaluate(
      ([key]) => {
        // Galaxy stores API key in sessionStorage
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (globalThis as any).sessionStorage;
        if (storage) {
          storage.setItem('galaxySession', JSON.stringify({ apiKey: key }));
        }
      },
      [apiKey]
    );

    // Also set as cookie for API requests
    await page.context().addCookies([
      {
        name: 'galaxysession',
        value: apiKey,
        domain: new URL(this.baseUrl).hostname,
        path: '/',
      },
    ]);

    // Reload to apply
    await page.reload({ waitUntil: 'networkidle' });
    await this.waitForGalaxyReady();

    console.log('  Authenticated with API key');
  }

  async openTool(toolId: string, jobId?: string, rerunDatasetId?: string): Promise<void> {
    const page = this.getPage();

    let toolUrl: string;

    if (rerunDatasetId) {
      // Dataset rerun mode: /tool_runner/rerun?id=<dataset_id>
      // This works for single-dataset output tools and shows correct inputs
      toolUrl = `${this.baseUrl}/tool_runner/rerun?id=${encodeURIComponent(rerunDatasetId)}`;
      // Add API key if available (needed for owned history access)
      if (this.apiKey) {
        toolUrl += `&key=${encodeURIComponent(this.apiKey)}`;
      }
      console.log(`  Opening tool in dataset rerun mode (dataset: ${rerunDatasetId})`);
    } else if (jobId) {
      // Job rerun mode: for map-over tools (needs text replacement after)
      const encodedToolId = encodeURIComponent(toolId);
      toolUrl = `${this.baseUrl}/?tool_id=${encodedToolId}&job_id=${encodeURIComponent(jobId)}`;
      console.log(`  Opening tool in job rerun mode (job: ${jobId})`);
    } else {
      // Default: just open tool form
      const encodedToolId = encodeURIComponent(toolId);
      toolUrl = `${this.baseUrl}/?tool_id=${encodedToolId}`;
    }
    console.log(`  Navigating to: ${toolUrl}`);
    await page.goto(toolUrl, { waitUntil: 'networkidle' });

    // Wait for tool form to load - try multiple possible selectors
    const toolFormSelectors = [
      '.tool-form',
      '[data-description="tool form"]',
      '.unified-panel-body form',
      '#center form',
      '.toolForm',
      '[id*="tool-form"]',
    ];

    console.log(`  Waiting for tool form...`);
    await page.waitForSelector(toolFormSelectors.join(', '), {
      timeout: 60000,
    });

    // Wait for form elements to be fully rendered
    await page.waitForTimeout(2000);
    console.log(`  Tool form loaded`);
  }

  async setParameter(param: string, value: string | number | boolean): Promise<void> {
    const page = this.getPage();

    // Galaxy form parameters have various selectors
    const selectors = [
      `[data-label="${param}"]`,
      `[name="${param}"]`,
      `#${param}`,
      `[data-name="${param}"]`,
    ];

    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element) {
        const tagName = await element.evaluate((el) => el.tagName.toLowerCase());

        if (tagName === 'select') {
          await element.selectOption(String(value));
        } else if (tagName === 'input') {
          const type = await element.getAttribute('type');
          if (type === 'checkbox') {
            if (value) {
              await element.check();
            } else {
              await element.uncheck();
            }
          } else {
            await element.fill(String(value));
          }
        } else {
          // Try clicking for dropdown-style selectors
          await element.click();
          await page.waitForTimeout(300);
          const optionSelector = `[data-value="${value}"], [value="${value}"]`;
          const option = await page.$(optionSelector);
          if (option) {
            await option.click();
          }
        }
        return;
      }
    }

    console.warn(`Parameter not found: ${param}`);
  }

  async click(selector: string): Promise<void> {
    const page = this.getPage();
    await page.click(selector);
  }

  async wait(options: { ms?: number; selector?: string }): Promise<void> {
    const page = this.getPage();
    if (options.selector) {
      await page.waitForSelector(options.selector, { timeout: 30000 });
    }
    if (options.ms) {
      await page.waitForTimeout(options.ms);
    }
  }

  async getElementBounds(selector: string): Promise<ElementBounds | null> {
    const page = this.getPage();
    const element = await page.$(selector);
    if (!element) return null;

    const box = await element.boundingBox();
    if (!box) return null;

    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    };
  }

  async captureScreenshot(options?: {
    selector?: string;
    fullPage?: boolean;
  }): Promise<Buffer> {
    const page = this.getPage();

    if (options?.selector) {
      const element = await page.$(options.selector);
      if (element) {
        return await element.screenshot() as Buffer;
      }
    }

    return await page.screenshot({
      fullPage: options?.fullPage ?? false,
    }) as Buffer;
  }

  async openUploadDialog(): Promise<void> {
    const page = this.getPage();
    // Click upload button
    await page.click('[data-description="upload button"], .upload-button, [title*="Upload"]');
    await page.waitForSelector('.upload-dialog, [data-description="upload dialog"]', {
      timeout: 10000,
    });
  }

  async uploadFromUrl(url: string, datatype?: string): Promise<void> {
    const page = this.getPage();
    await this.openUploadDialog();

    // Switch to paste/fetch tab
    await page.click('[data-description="paste button"], .paste-button, :text("Paste/Fetch")');
    await page.waitForTimeout(500);

    // Enter URL
    await page.fill('textarea.upload-text-content, textarea[placeholder*="URL"]', url);

    // Set datatype if specified
    if (datatype) {
      await page.click('[data-description="extension selector"], .extension-select');
      await page.fill('input[placeholder*="Search"]', datatype);
      await page.click(`[data-value="${datatype}"], :text("${datatype}")`);
    }

    // Start upload
    await page.click('[data-description="start button"], .start-button, :text("Start")');
  }

  /**
   * Select a dataset from history for an input parameter
   */
  async selectDatasetInput(paramLabel: string, datasetName: string): Promise<boolean> {
    const page = this.getPage();

    // Find the parameter row by label
    const paramSelectors = [
      `[data-label="${paramLabel}"]`,
      `[data-label*="${paramLabel}"]`,
      `.form-row:has-text("${paramLabel}")`,
      `label:has-text("${paramLabel}")`,
    ];

    let paramRow = null;
    for (const selector of paramSelectors) {
      paramRow = await page.$(selector);
      if (paramRow) break;
    }

    if (!paramRow) {
      console.warn(`  Parameter "${paramLabel}" not found`);
      return false;
    }

    // Find and click the dataset selector button/dropdown within the param row
    const selectorButtons = [
      '.dataset-selector button',
      '.dropdown-toggle',
      'button[data-toggle="dropdown"]',
      '.btn-group button',
      '[data-description="dataset selector"]',
    ];

    let clicked = false;
    for (const btnSelector of selectorButtons) {
      const btn = await paramRow.$(btnSelector);
      if (btn) {
        await btn.click();
        clicked = true;
        break;
      }
    }

    // If no button found, try clicking the row itself
    if (!clicked) {
      await paramRow.click();
    }

    await page.waitForTimeout(500);

    // Look for dataset in dropdown by name
    const datasetSelectors = [
      `[data-hid]:has-text("${datasetName}")`,
      `.dropdown-menu li:has-text("${datasetName}")`,
      `.list-item:has-text("${datasetName}")`,
      `[title*="${datasetName}"]`,
      `:text("${datasetName}")`,
    ];

    for (const dsSelector of datasetSelectors) {
      const dataset = await page.$(dsSelector);
      if (dataset) {
        await dataset.click();
        console.log(`  Selected dataset: ${datasetName}`);
        await page.waitForTimeout(300);
        return true;
      }
    }

    console.warn(`  Dataset "${datasetName}" not found in dropdown`);
    return false;
  }

  /**
   * Switch to a specific history by ID
   */
  async switchToHistory(historyId: string): Promise<void> {
    const page = this.getPage();

    // Use Galaxy API to switch history via URL
    await page.goto(`${this.baseUrl}/history/switch_to_history?id=${historyId}`, {
      waitUntil: 'networkidle',
    });
    await this.waitForGalaxyReady();
  }

  /**
   * Expand all collapsed form sections (if needed)
   * Per user decision: keep collapsed, but we still fill visible fields
   */
  async expandCollapsedSections(): Promise<void> {
    const page = this.getPage();

    // Find collapsed sections and expand them
    const collapsedSelectors = [
      '.ui-portlet-collapsible.collapsed .portlet-title-text',
      '.portlet-header.collapsed',
      '[data-description="section header"].collapsed',
      '.ui-form-element.collapsed .ui-form-title',
    ];

    for (const selector of collapsedSelectors) {
      const collapsed = await page.$$(selector);
      for (const el of collapsed) {
        try {
          await el.click();
          await page.waitForTimeout(200);
        } catch {
          // Ignore click errors
        }
      }
    }
  }

  /**
   * Set a select/dropdown value (handles Vue-select components)
   */
  async setSelectValue(paramLabel: string, value: string, displayLabel?: string): Promise<boolean> {
    const page = this.getPage();

    // Find the form row containing this parameter
    const formRow = await this.findFormRow(paramLabel);
    if (!formRow) {
      console.warn(`  Parameter row not found: ${paramLabel}`);
      return false;
    }

    // Try different select element types
    // 1. Native select
    const nativeSelect = await formRow.$('select');
    if (nativeSelect) {
      try {
        await nativeSelect.selectOption(value);
        console.log(`  Set ${paramLabel} = ${displayLabel || value}`);
        return true;
      } catch {
        // Try by label if value fails
        if (displayLabel) {
          await nativeSelect.selectOption({ label: displayLabel });
          console.log(`  Set ${paramLabel} = ${displayLabel}`);
          return true;
        }
      }
    }

    // 2. Vue-select / multiselect dropdown
    const vueSelect = await formRow.$('.multiselect, .vs__dropdown-toggle, [data-v-select]');
    if (vueSelect) {
      await vueSelect.click();
      await page.waitForTimeout(300);

      // Look for option in dropdown
      const optionSelectors = [
        `.multiselect__option:has-text("${displayLabel || value}")`,
        `.vs__dropdown-option:has-text("${displayLabel || value}")`,
        `[data-value="${value}"]`,
        `li:has-text("${displayLabel || value}")`,
      ];

      for (const optSelector of optionSelectors) {
        const option = await page.$(optSelector);
        if (option) {
          await option.click();
          console.log(`  Set ${paramLabel} = ${displayLabel || value}`);
          return true;
        }
      }
    }

    // 3. Radio buttons
    const radios = await formRow.$$('input[type="radio"]');
    if (radios.length > 0) {
      for (const radio of radios) {
        const radioValue = await radio.getAttribute('value');
        if (radioValue === value) {
          await radio.click();
          console.log(`  Set ${paramLabel} = ${displayLabel || value}`);
          return true;
        }
      }
    }

    // 4. Button group (toggle buttons)
    const buttonGroup = await formRow.$('.btn-group, [role="group"]');
    if (buttonGroup) {
      const buttons = await buttonGroup.$$('button, .btn');
      for (const btn of buttons) {
        const btnValue = await btn.getAttribute('data-value') || await btn.getAttribute('value');
        const btnText = await btn.textContent();
        if (btnValue === value || btnText?.trim() === (displayLabel || value)) {
          await btn.click();
          console.log(`  Set ${paramLabel} = ${displayLabel || value}`);
          return true;
        }
      }
    }

    console.warn(`  Could not set select value: ${paramLabel} = ${value}`);
    return false;
  }

  /**
   * Set a text/number input value
   */
  async setInputValue(paramLabel: string, value: string | number): Promise<boolean> {
    const page = this.getPage();

    const formRow = await this.findFormRow(paramLabel);
    if (!formRow) {
      console.warn(`  Parameter row not found: ${paramLabel}`);
      return false;
    }

    const input = await formRow.$('input[type="text"], input[type="number"], input:not([type="radio"]):not([type="checkbox"]), textarea');
    if (input) {
      await input.fill(String(value));
      console.log(`  Set ${paramLabel} = ${value}`);
      return true;
    }

    console.warn(`  Could not set input value: ${paramLabel}`);
    return false;
  }

  /**
   * Set a checkbox/boolean value
   */
  async setCheckboxValue(paramLabel: string, value: boolean): Promise<boolean> {
    const page = this.getPage();

    const formRow = await this.findFormRow(paramLabel);
    if (!formRow) {
      console.warn(`  Parameter row not found: ${paramLabel}`);
      return false;
    }

    const checkbox = await formRow.$('input[type="checkbox"]');
    if (checkbox) {
      if (value) {
        await checkbox.check();
      } else {
        await checkbox.uncheck();
      }
      console.log(`  Set ${paramLabel} = ${value ? 'Yes' : 'No'}`);
      return true;
    }

    console.warn(`  Could not set checkbox value: ${paramLabel}`);
    return false;
  }

  /**
   * Select a dataset by HID (more reliable than name)
   */
  async selectDatasetByHid(paramLabel: string, hid: number, datasetName?: string): Promise<boolean> {
    const page = this.getPage();

    const formRow = await this.findFormRow(paramLabel);
    if (!formRow) {
      console.warn(`  Parameter row not found: ${paramLabel}`);
      return false;
    }

    // Click to open dataset selector
    const selectorTriggers = [
      '.dataset-selector',
      '.multiselect',
      '.dropdown-toggle',
      'button',
      '.btn',
    ];

    let clicked = false;
    for (const trigger of selectorTriggers) {
      const el = await formRow.$(trigger);
      if (el) {
        await el.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await formRow.click();
    }

    await page.waitForTimeout(500);

    // Look for dataset by HID pattern: "17: data" or "#17" etc.
    const hidPatterns = [
      `${hid}:`,
      `#${hid}`,
      `${hid} :`,
    ];

    // Try finding by HID
    for (const pattern of hidPatterns) {
      const datasetOption = await page.$(`[data-hid="${hid}"], .dropdown-item:has-text("${pattern}"), .multiselect__option:has-text("${pattern}"), li:has-text("${pattern}")`);
      if (datasetOption) {
        await datasetOption.click();
        console.log(`  Selected input: ${hid}: ${datasetName || '(dataset)'}`);
        return true;
      }
    }

    // Fallback: try by name if provided
    if (datasetName) {
      const byName = await page.$(`.dropdown-item:has-text("${datasetName}"), .multiselect__option:has-text("${datasetName}")`);
      if (byName) {
        await byName.click();
        console.log(`  Selected input: ${datasetName}`);
        return true;
      }
    }

    console.warn(`  Could not select dataset: HID ${hid}`);
    return false;
  }

  /**
   * Select a collection by HID - first tries by paramLabel, then any empty input
   */
  async selectCollectionByHid(paramLabel: string, hid: number, collectionName?: string): Promise<boolean> {
    const page = this.getPage();

    // Try to find form row by param label
    let formRow = await this.findFormRow(paramLabel);

    // If not found, try to find any form row with "Select Value" or similar empty indicator
    if (!formRow) {
      const emptyInputSelectors = [
        '.form-group:has(.multiselect:has-text("Select Value"))',
        '.form-row:has(.multiselect:has-text("Select Value"))',
        '[data-description*="input"]:has(.multiselect:has-text("Select"))',
      ];

      for (const selector of emptyInputSelectors) {
        formRow = await page.$(selector);
        if (formRow) {
          console.log(`  Found empty input field for collection selection`);
          break;
        }
      }
    }

    if (!formRow) {
      // Last resort: find multiselect with "Select Value" directly
      const emptyMultiselect = page.locator('.multiselect:has-text("Select Value")').first();
      if (await emptyMultiselect.count() > 0) {
        await emptyMultiselect.click();
        await page.waitForTimeout(500);

        // Look for collection in dropdown
        const collectionOption = page.locator(`text=/${hid}:/`).first();
        if (await collectionOption.count() > 0) {
          await collectionOption.click();
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          console.log(`  Selected collection: ${hid}: ${collectionName || '(collection)'}`);
          return true;
        }
        await page.keyboard.press('Escape');
      }

      console.warn(`  Could not find input field for collection`);
      return false;
    }

    // First, may need to switch to "collection" mode in the input selector
    const collectionTab = await formRow.$('[data-description="collection input"], .collection-selector-toggle, :text("Collection")');
    if (collectionTab) {
      await collectionTab.click();
      await page.waitForTimeout(300);
    }

    // Click to open selector
    const selectorTriggers = [
      '.dataset-selector',
      '.collection-selector',
      '.multiselect',
      '.dropdown-toggle',
      'button',
    ];

    for (const trigger of selectorTriggers) {
      const el = await formRow.$(trigger);
      if (el) {
        await el.click();
        break;
      }
    }

    await page.waitForTimeout(500);

    // Look for collection by HID
    const hidPatterns = [
      `${hid}:`,
      `#${hid}`,
    ];

    for (const pattern of hidPatterns) {
      const collectionOption = await page.$(`[data-hid="${hid}"], .dropdown-item:has-text("${pattern}"), .multiselect__option:has-text("${pattern}"), li:has-text("${pattern}")`);
      if (collectionOption) {
        await collectionOption.click();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        console.log(`  Selected collection: ${hid}: ${collectionName || '(collection)'}`);
        return true;
      }
    }

    console.warn(`  Could not select collection: HID ${hid}`);
    return false;
  }

  /**
   * Replace collection input display text entirely
   * Finds elements containing "(as dataset collection)" and replaces entire content
   */
  async replaceCollectionInputText(collectionText: string): Promise<boolean> {
    const page = this.getPage();

    // Find selection displays containing "(as dataset collection)" marker
    const selectors = [
      '.multiselect__single',
      '.multiselect__tag',
      '.selection-text',
      '[data-description="selection"]',
    ];

    let replaced = false;
    const marker = '(as dataset collection)';

    for (const selector of selectors) {
      const elements = page.locator(selector);
      const count = await elements.count();

      for (let i = 0; i < count; i++) {
        const el = elements.nth(i);
        const text = await el.textContent();

        if (text && text.includes(marker)) {
          // Replace entire text content with collection info
          await el.evaluate((node, newText) => {
            node.textContent = newText;
          }, collectionText);
          replaced = true;
          console.log(`  Replaced input display with "${collectionText}"`);
        }
      }
    }

    return replaced;
  }

  /**
   * Find a form row by parameter label
   */
  private async findFormRow(paramLabel: string): Promise<any> {
    const page = this.getPage();

    const rowSelectors = [
      `.ui-form-element:has(.ui-form-title:has-text("${paramLabel}"))`,
      `.form-row:has(label:has-text("${paramLabel}"))`,
      `[data-label="${paramLabel}"]`,
      `.ui-form-element:has-text("${paramLabel}")`,
      // Handle exact match vs contains
      `.ui-form-element:has(.ui-form-title-text:text-is("${paramLabel}"))`,
    ];

    for (const selector of rowSelectors) {
      try {
        const row = await page.$(selector);
        if (row) return row;
      } catch {
        // Selector may be invalid
      }
    }

    return null;
  }

  /**
   * Fill tool form from job parameters
   */
  async fillFormFromJobParams(
    jobParams: JobFullParams,
    formMapper: FormMapper,
    historyCollections: Map<string, { hid: number; name: string }>,
    options?: { fillConditionalFirst?: boolean }
  ): Promise<void> {
    const page = this.getPage();
    const mapping = await formMapper.buildFormMapping(jobParams.toolId);

    // Determine fill order - conditionals first
    const fillOrder = await formMapper.determineFillOrder(jobParams.toolId, jobParams.params);

    console.log(`  Filling form with ${Object.keys(jobParams.params).length} params...`);

    // First pass: set conditional/select params that may change form structure
    for (const paramName of fillOrder) {
      const param = jobParams.params[paramName];
      if (!param) continue;

      const fieldInfo = mapping.get(paramName);
      const label = fieldInfo?.label || paramName;

      // Skip dataset/collection inputs - handle separately
      if (param.isDataset || param.isCollection) continue;

      // Check if value differs from default
      const isNonDefault = await formMapper.isNonDefault(jobParams.toolId, paramName, param.value);
      if (!isNonDefault) continue;

      // Set the value based on type
      if (fieldInfo?.type === 'select' || fieldInfo?.type === 'conditional') {
        const displayLabel = await formMapper.getSelectOptionLabel(jobParams.toolId, paramName, String(param.value));
        await this.setSelectValue(label, String(param.value), displayLabel);
        // Wait for form to update after conditional change
        await page.waitForTimeout(500);
      } else if (fieldInfo?.type === 'boolean') {
        await this.setCheckboxValue(label, Boolean(param.value));
      } else if (fieldInfo?.type === 'text' || fieldInfo?.type === 'integer' || fieldInfo?.type === 'float') {
        await this.setInputValue(label, String(param.value));
      } else {
        // Try generic set
        await this.setInputValue(label, String(param.value));
      }
    }

    // Second pass: handle dataset/collection inputs
    for (const [inputName, inputRef] of Object.entries(jobParams.inputs)) {
      const fieldInfo = mapping.get(inputName);
      const label = fieldInfo?.label || inputName;

      // Check if this is a collection reference
      const paramValue = jobParams.params[inputName];
      if (paramValue?.isCollection) {
        // Resolve collection HID
        const collectionInfo = historyCollections.get(inputRef.id);
        if (collectionInfo) {
          await this.selectCollectionByHid(label, collectionInfo.hid, collectionInfo.name);
        }
      } else if (paramValue?.isDataset || inputRef.src === 'hda' || inputRef.src === 'ldda') {
        // Regular dataset - would need to resolve HID from history
        // For now, log warning
        console.warn(`  Dataset input ${label} - need HID resolution`);
      }
    }
  }
}
