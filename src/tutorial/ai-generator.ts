import { AIConfig, TutorialConfig, Section } from './types';

export class AIGenerator {
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  async generateText(prompt: string, context: Section): Promise<string> {
    const systemPrompt = `You are a technical writer creating Galaxy Training Network (GTN) tutorials.
Write clear, concise explanations for bioinformatics workflows.
Use active voice and be direct. Define technical terms on first use.
Do not use excessive hedging or filler phrases.`;

    const fullPrompt = `Section: ${context.title}
Type: ${context.type}

${prompt}

Write 2-4 sentences explaining this in the context of a Galaxy tutorial.`;

    return await this.callAPI(systemPrompt, fullPrompt);
  }

  async generateDetailsContent(topic: string): Promise<string> {
    const systemPrompt = `You are a technical writer creating Galaxy Training Network (GTN) tutorials.
Write educational content explaining bioinformatics concepts and file formats.
Be thorough but accessible. Use examples where helpful.
Format with markdown: use **bold** for emphasis, \`code\` for technical terms, and bullet lists where appropriate.`;

    const fullPrompt = `Write an educational explanation about: ${topic}

This will appear in a "details" block that users can expand for more information.
Include:
- What it is and why it matters
- Key characteristics or components
- Practical relevance for the analysis

Write 2-4 paragraphs.`;

    return await this.callAPI(systemPrompt, fullPrompt);
  }

  async generateKeyPoints(config: TutorialConfig): Promise<string[]> {
    const systemPrompt = `You are a technical writer creating Galaxy Training Network (GTN) tutorials.
Generate concise key learning points that summarize what users will learn.`;

    // Build context from sections
    const sectionSummary = config.sections
      .map((s) => `- ${s.title} (${s.type})`)
      .join('\n');

    const fullPrompt = `Tutorial: ${config.metadata.title}

Objectives:
${config.metadata.objectives.map((o) => `- ${o}`).join('\n')}

Sections:
${sectionSummary}

Generate 5-7 key points (one sentence each) that summarize the main takeaways from this tutorial.
Return as a JSON array of strings.`;

    const response = await this.callAPI(systemPrompt, fullPrompt);

    try {
      // Try to parse as JSON
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall back to line-by-line parsing
      return response
        .split('\n')
        .filter((line) => line.trim().startsWith('-'))
        .map((line) => line.replace(/^-\s*/, '').trim());
    }

    return [];
  }

  async generateToolExplanation(
    toolName: string,
    toolId: string,
    params: { label: string; value: string }[]
  ): Promise<string> {
    const systemPrompt = `You are a technical writer creating Galaxy Training Network (GTN) tutorials.
Explain what bioinformatics tools do in the context of an analysis workflow.`;

    const paramSummary = params.map((p) => `- ${p.label}: ${p.value}`).join('\n');

    const fullPrompt = `Explain what the ${toolName} tool does and why we're using these specific parameters:

Tool: ${toolName}
Parameters:
${paramSummary}

Write 1-2 sentences explaining the purpose of this step in the workflow.`;

    return await this.callAPI(systemPrompt, fullPrompt);
  }

  async generateToolExplanationWithContext(
    toolName: string,
    toolId: string,
    params: { label: string; value: string }[],
    historyContext: string
  ): Promise<string> {
    const systemPrompt = `You are a technical writer creating Galaxy Training Network (GTN) tutorials.
Explain what bioinformatics tools do in the context of an analysis workflow.
Reference the specific input data when explaining the step.`;

    const paramSummary = params.length > 0
      ? params.map((p) => `- ${p.label}: ${p.value}`).join('\n')
      : '(using default parameters)';

    const fullPrompt = `Explain what the ${toolName} tool does in this workflow step.

Tool: ${toolName}
Input data: ${historyContext}
Parameters:
${paramSummary}

Write 2-3 sentences explaining:
1. What this tool does
2. Why we're running it on this specific data
3. What output to expect`;

    return await this.callAPI(systemPrompt, fullPrompt);
  }

  private async callAPI(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = this.config.api_key || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn('No API key configured for AI generation. Returning placeholder.');
      return '[AI-generated content placeholder]';
    }

    if (this.config.provider === 'anthropic') {
      return await this.callAnthropic(apiKey, systemPrompt, userPrompt);
    } else {
      return await this.callOpenAI(apiKey, systemPrompt, userPrompt);
    }
  }

  private async callAnthropic(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const model = this.config.model || 'claude-sonnet-4-20250514';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Anthropic API error:', error);
      return '[AI generation failed]';
    }

    const data = await response.json() as { content: Array<{ text?: string }> };
    return data.content[0]?.text || '';
  }

  private async callOpenAI(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const model = this.config.model || 'gpt-4';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI API error:', error);
      return '[AI generation failed]';
    }

    const data = await response.json() as { choices: Array<{ message?: { content?: string } }> };
    return data.choices[0]?.message?.content || '';
  }
}
