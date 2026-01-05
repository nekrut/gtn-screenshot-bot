import { HistoryDataset, HistoryDetails, ExecutedJob } from '../galaxy/history-client';

interface WorkflowStep {
  id: number;
  type: string;
  tool_id?: string;
  name: string;
  annotation?: string;
  input_connections?: Record<string, unknown>;
  inputs?: Array<{ name: string; description?: string }>;
}

interface GalaxyWorkflow {
  name: string;
  steps: Record<string, WorkflowStep>;
}

export interface ExecutedStep {
  workflowStepId?: number;
  toolId: string;
  toolName: string;
  inputs: HistoryDataset[];
  outputs: HistoryDataset[];
  executionOrder: number;
}

/**
 * History-driven enricher that uses the jobs API to determine which tools ran
 */
export class HistoryEnricher {
  private workflow: GalaxyWorkflow;
  private history: HistoryDetails;
  private workflowStepsByToolId: Map<string, WorkflowStep>;

  constructor(workflow: GalaxyWorkflow, history: HistoryDetails) {
    this.workflow = workflow;
    this.history = history;

    // Index workflow steps by tool_id for quick lookup
    this.workflowStepsByToolId = new Map();
    for (const step of Object.values(workflow.steps)) {
      if (step.tool_id) {
        // Extract base tool ID (without version for matching)
        const baseToolId = this.extractBaseToolId(step.tool_id);
        this.workflowStepsByToolId.set(baseToolId, step);
        // Also store full tool_id
        this.workflowStepsByToolId.set(step.tool_id, step);
      }
    }
  }

  /**
   * Extract base tool ID without version
   * e.g., "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0" -> "fastp"
   */
  private extractBaseToolId(toolId: string): string {
    const parts = toolId.split('/');
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return toolId;
  }

  /**
   * Get a human-readable tool name from tool_id
   */
  private getToolName(toolId: string): string {
    // Check workflow for name
    const baseToolId = this.extractBaseToolId(toolId);
    const workflowStep = this.workflowStepsByToolId.get(toolId) ||
                        this.workflowStepsByToolId.get(baseToolId);
    if (workflowStep?.name) {
      return workflowStep.name;
    }

    // Fall back to extracting name from tool_id
    // toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0 -> fastp
    // devteam/fastqc -> fastqc
    return baseToolId;
  }

  /**
   * Get input datasets (those without creating_job - workflow inputs)
   */
  getInputDatasets(): HistoryDataset[] {
    return this.history.datasets.filter(d => !d.creating_job);
  }

  /**
   * Build list of executed steps from history jobs
   */
  getExecutedSteps(): ExecutedStep[] {
    const jobs = this.history.jobs;
    if (!jobs || jobs.length === 0) {
      return [];
    }

    const steps: ExecutedStep[] = [];

    // Process jobs in order (they're already sorted by create_time)
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const toolId = job.tool_id;
      const baseToolId = this.extractBaseToolId(toolId);
      const workflowStep = this.workflowStepsByToolId.get(toolId) ||
                          this.workflowStepsByToolId.get(baseToolId);

      const toolName = this.getToolName(toolId);

      // For inputs, we use the datasets that existed before this job ran
      // This is a heuristic - ideally we'd trace job inputs directly
      const allDatasets = this.history.datasets;

      steps.push({
        workflowStepId: workflowStep?.id,
        toolId,
        toolName,
        inputs: [], // We'll fill this from history context
        outputs: [],
        executionOrder: i,
      });
    }

    return steps;
  }

  /**
   * Get history context string for AI generation
   */
  getHistoryContext(step: ExecutedStep): string {
    // For now, return empty - will be filled by workflow-converter
    return '';
  }

  /**
   * Legacy method for backward compatibility - returns enriched steps
   */
  enrichSteps(): Array<{
    stepId: number;
    toolId: string;
    toolName: string;
    inputDatasets: Array<{
      paramLabel: string;
      datasetName: string;
      datasetId: string;
      extension: string;
    }>;
    historyContext: string;
  }> {
    const executedSteps = this.getExecutedSteps();

    return executedSteps.map((step, index) => ({
      stepId: step.workflowStepId || index,
      toolId: step.toolId,
      toolName: step.toolName,
      inputDatasets: step.inputs.map(input => ({
        paramLabel: 'Input',
        datasetName: input.name,
        datasetId: input.id,
        extension: input.extension,
      })),
      historyContext: this.getHistoryContext(step),
    }));
  }
}

// Re-export types for backward compatibility
export type { HistoryDataset } from '../galaxy/history-client';

export interface InputDatasetMapping {
  paramLabel: string;
  datasetName: string;
  datasetId: string;
  extension: string;
}

export interface EnrichedStep {
  stepId: number;
  toolId: string;
  toolName: string;
  inputDatasets: InputDatasetMapping[];
  historyContext: string;
}
