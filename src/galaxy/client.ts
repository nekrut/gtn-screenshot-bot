import { Browser, Page, chromium } from 'playwright';
import { ScreenshotConfig, ElementBounds } from '../config/types';

export class GalaxyClient {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private baseUrl: string;

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
    await this.navigate('/login');

    await page.fill('input[name="login"], #login', username);
    await page.fill('input[name="password"], #password', password);
    await page.click('button[type="submit"], input[type="submit"]');

    await this.waitForGalaxyReady();
  }

  async loginWithApiKey(apiKey: string): Promise<void> {
    const page = this.getPage();

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

  async openTool(toolId: string): Promise<void> {
    const page = this.getPage();

    // Navigate directly to tool URL
    const encodedToolId = encodeURIComponent(toolId);
    const toolUrl = `${this.baseUrl}/?tool_id=${encodedToolId}`;
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
}
