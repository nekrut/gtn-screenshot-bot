/**
 * Tool form schema mapping - maps internal param names to form labels
 * Uses GET /api/tools/{tool_id}/build to get form structure
 */

export interface FormInput {
  name: string;
  label?: string;
  type: string;  // 'data', 'select', 'text', 'boolean', 'conditional', 'repeat', 'section', etc.
  value?: unknown;  // default value
  optional?: boolean;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  cases?: ConditionalCase[];  // for conditional type
  inputs?: FormInput[];  // nested inputs (sections, conditionals, repeats)
  test_param?: FormInput;  // for conditional - the param that controls which case
}

export interface ConditionalCase {
  value: string;
  inputs: FormInput[];
}

export interface ToolFormSchema {
  id: string;
  name: string;
  version: string;
  description?: string;
  inputs: FormInput[];
  state_inputs?: Record<string, unknown>;  // default values
}

export interface FormFieldMapping {
  internalName: string;
  label: string;
  type: string;
  path: string[];  // path to this field in nested structure
  defaultValue?: unknown;
  parentConditional?: string;
  parentConditionalValue?: string;
  options?: Array<{ value: string; label: string }>;
}

export class FormMapper {
  private galaxyUrl: string;
  private apiKey: string;
  private schemaCache: Map<string, ToolFormSchema> = new Map();
  private mappingCache: Map<string, Map<string, FormFieldMapping>> = new Map();

  constructor(galaxyUrl: string, apiKey: string) {
    this.galaxyUrl = galaxyUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Fetch tool form schema from Galaxy API
   */
  async fetchToolFormSchema(toolId: string, historyId?: string): Promise<ToolFormSchema> {
    // Check cache first
    if (this.schemaCache.has(toolId)) {
      return this.schemaCache.get(toolId)!;
    }

    // Build URL with optional history_id
    const encodedToolId = encodeURIComponent(toolId);
    let url = `${this.galaxyUrl}/api/tools/${encodedToolId}/build`;
    if (historyId) {
      url += `?history_id=${encodeURIComponent(historyId)}`;
    }

    const response = await fetch(url, {
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch tool schema for ${toolId}: ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;

    const schema: ToolFormSchema = {
      id: String(data.id || toolId),
      name: String(data.name || ''),
      version: String(data.version || ''),
      description: data.description ? String(data.description) : undefined,
      inputs: (data.inputs || []) as FormInput[],
      state_inputs: data.state_inputs as Record<string, unknown> | undefined,
    };

    this.schemaCache.set(toolId, schema);
    return schema;
  }

  /**
   * Build name -> label mapping from tool schema
   */
  async buildFormMapping(toolId: string): Promise<Map<string, FormFieldMapping>> {
    // Check cache first
    if (this.mappingCache.has(toolId)) {
      return this.mappingCache.get(toolId)!;
    }

    const schema = await this.fetchToolFormSchema(toolId);
    const mapping = new Map<string, FormFieldMapping>();

    // Recursively process inputs
    this.processInputs(schema.inputs, [], mapping);

    this.mappingCache.set(toolId, mapping);
    return mapping;
  }

  /**
   * Recursively process form inputs to build mapping
   */
  private processInputs(
    inputs: FormInput[],
    path: string[],
    mapping: Map<string, FormFieldMapping>,
    parentConditional?: string,
    parentConditionalValue?: string
  ): void {
    for (const input of inputs) {
      const currentPath = [...path, input.name];
      const fullName = currentPath.join('|');

      mapping.set(input.name, {
        internalName: input.name,
        label: input.label || input.name,
        type: input.type,
        path: currentPath,
        defaultValue: input.value,
        parentConditional,
        parentConditionalValue,
        options: input.options,
      });

      // Also map by full path for nested params
      if (path.length > 0) {
        mapping.set(fullName, {
          internalName: fullName,
          label: input.label || input.name,
          type: input.type,
          path: currentPath,
          defaultValue: input.value,
          parentConditional,
          parentConditionalValue,
          options: input.options,
        });
      }

      // Handle nested structures
      if (input.type === 'conditional' && input.cases) {
        // Process the test param
        if (input.test_param) {
          mapping.set(input.test_param.name, {
            internalName: input.test_param.name,
            label: input.test_param.label || input.test_param.name,
            type: input.test_param.type,
            path: [...path, input.name, input.test_param.name],
            defaultValue: input.test_param.value,
            options: input.test_param.options,
          });
        }

        // Process each case
        for (const caseItem of input.cases) {
          this.processInputs(
            caseItem.inputs,
            [...path, input.name],
            mapping,
            input.test_param?.name,
            caseItem.value
          );
        }
      } else if (input.type === 'section' && input.inputs) {
        this.processInputs(input.inputs, currentPath, mapping, parentConditional, parentConditionalValue);
      } else if (input.type === 'repeat' && input.inputs) {
        // For repeats, map the child inputs with a generic path
        this.processInputs(input.inputs, currentPath, mapping, parentConditional, parentConditionalValue);
      } else if (input.inputs) {
        // Generic nested inputs
        this.processInputs(input.inputs, currentPath, mapping, parentConditional, parentConditionalValue);
      }
    }
  }

  /**
   * Get the label for a parameter name
   */
  async getParamLabel(toolId: string, paramName: string): Promise<string> {
    const mapping = await this.buildFormMapping(toolId);
    const field = mapping.get(paramName);
    return field?.label || paramName;
  }

  /**
   * Check if a param value differs from default
   */
  async isNonDefault(toolId: string, paramName: string, value: unknown): Promise<boolean> {
    const mapping = await this.buildFormMapping(toolId);
    const field = mapping.get(paramName);

    if (!field) {
      return true;  // Unknown param, assume non-default
    }

    // Compare with default value
    const defaultValue = field.defaultValue;

    if (defaultValue === undefined || defaultValue === null) {
      // No default, check if value is "empty"
      if (value === null || value === undefined || value === '' || value === false) {
        return false;  // Empty value for no-default param is "default"
      }
      return true;
    }

    // Deep comparison
    return JSON.stringify(value) !== JSON.stringify(defaultValue);
  }

  /**
   * Determine fill order for params (conditionals first)
   */
  async determineFillOrder(
    toolId: string,
    params: Record<string, unknown>
  ): Promise<string[]> {
    const mapping = await this.buildFormMapping(toolId);
    const conditionals: string[] = [];
    const regular: string[] = [];

    for (const paramName of Object.keys(params)) {
      const field = mapping.get(paramName);
      if (field?.type === 'select' && field.parentConditional === undefined) {
        // Top-level selects might be conditionals - fill first
        conditionals.push(paramName);
      } else if (field?.parentConditional) {
        // This param depends on a conditional
        regular.push(paramName);
      } else {
        regular.push(paramName);
      }
    }

    return [...conditionals, ...regular];
  }

  /**
   * Get display value for a select option
   */
  async getSelectOptionLabel(toolId: string, paramName: string, value: string): Promise<string> {
    const mapping = await this.buildFormMapping(toolId);
    const field = mapping.get(paramName);

    if (field?.options) {
      const option = field.options.find(o => o.value === value);
      if (option) {
        return option.label;
      }
    }

    return value;
  }
}
