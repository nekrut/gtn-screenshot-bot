# GTN Screenshot Bot

Automated tutorial and screenshot generation for [Galaxy Training Network](https://training.galaxyproject.org) (GTN). Generates complete GTN-formatted tutorials from Galaxy workflows, including AI-generated explanations and automated tool screenshots.

## Overview

This tool takes a Galaxy workflow (`.ga` file) and optionally a Galaxy history URL, then generates:
- Complete `tutorial.md` in GTN kramdown format
- Screenshots of each tool's interface
- AI-generated explanations for each tool step

### Key Feature: History-Driven Generation

The tool uses the **Galaxy history as the source of truth** to determine which tools actually executed. This handles:
- **Conditional workflows**: Only tools that ran appear in the tutorial
- **Complex branching**: Multiple execution paths are correctly handled
- **Subworkflows**: Flattened into executed tool steps

The history is queried via `/api/jobs?history_id=X` to get all executed jobs, filtered to remove internal workflow helper tools.

## Quick Start

```bash
# Install
npm install
npm run build

# Create API key files (gitignored)
echo "your-galaxy-api-key" > .galaxy-api-key
echo "sk-ant-api03-..." > .anthropic-api-key

# Download a workflow
curl -O https://raw.githubusercontent.com/iwc-workflows/rnaseq-pe/main/rnaseq-pe.ga

# Generate tutorial from workflow + history
npx tsx src/cli.ts from-workflow \
  -w rnaseq-pe.ga \
  -o tutorial-config.yaml \
  -h "https://usegalaxy.org/u/username/h/history-slug" \
  --output-dir ./output \
  --images-dir ./output/images \
  --generate
```

## Architecture

```
src/
├── cli.ts                    # Command-line interface (commander.js)
├── galaxy/
│   ├── client.ts             # Playwright-based Galaxy browser automation
│   ├── history-client.ts     # Galaxy History/Jobs API client
│   └── api-key-loader.ts     # Load API keys from .galaxy-api-key/.anthropic-api-key
├── tutorial/
│   ├── types.ts              # TypeScript types for GTN tutorial format
│   ├── generator.ts          # Main tutorial generation orchestrator
│   ├── ai-generator.ts       # Anthropic/OpenAI API for explanations
│   ├── workflow-converter.ts # Convert .ga workflow to TutorialConfig
│   ├── history-enricher.ts   # Extract executed tools from history jobs
│   └── recording-converter.ts # Convert Chrome DevTools recordings
├── capture/
│   ├── screenshot.ts         # Screenshot capture runner
│   └── annotate.ts           # Image annotation (boxes, arrows)
└── config/
    └── types.ts              # Screenshot config types
```

### Data Flow

```
Workflow (.ga) + History URL
        ↓
┌───────────────────────┐
│  workflow-converter   │  Parse workflow JSON, fetch history jobs
└───────────────────────┘
        ↓
┌───────────────────────┐
│  history-enricher     │  Match jobs to workflow steps, filter helpers
└───────────────────────┘
        ↓
┌───────────────────────┐
│  TutorialConfig       │  YAML config with sections, tools, screenshots
└───────────────────────┘
        ↓
┌───────────────────────┐
│  TutorialGenerator    │  Orchestrate screenshot + AI generation
└───────────────────────┘
        ↓
┌─────────────┬─────────────┐
│ GalaxyClient│ AIGenerator │
│ (Playwright)│ (Anthropic) │
└─────────────┴─────────────┘
        ↓
    tutorial.md + images/
```

## API Key Setup

Create two files in the project root (both are gitignored):

```bash
# Galaxy API key (for history access + authenticated screenshots)
echo "your-galaxy-api-key" > .galaxy-api-key

# Anthropic API key (for AI-generated explanations)
echo "sk-ant-api03-..." > .anthropic-api-key
```

Keys are auto-loaded by `api-key-loader.ts`. CLI flags override file-based keys.

## CLI Commands

| Command | Description |
|---------|-------------|
| `from-workflow` | Convert Galaxy workflow to tutorial config (+ optional generation) |
| `generate` | Generate tutorial from existing config YAML |
| `screenshots` | Capture screenshots only (no tutorial generation) |
| `convert` | Convert Chrome DevTools recording to config |
| `init` | Create template config file |

### from-workflow Options

```
-w, --workflow <path>     Path to Galaxy workflow (.ga) file [required]
-o, --output <path>       Output path for config YAML [required]
-h, --history <url>       Galaxy history URL (enables history-driven mode)
--output-dir <dir>        Tutorial output directory (default: ./output)
--images-dir <dir>        Images output directory (default: ./output/images)
--generate                Also generate the tutorial (not just config)
--url <url>               Galaxy URL (default: https://usegalaxy.org)
--api-key <key>           Galaxy API key (overrides .galaxy-api-key)
--anthropic-key <key>     Anthropic API key (overrides .anthropic-api-key)
```

### generate Options

```
-c, --config <path>       Path to tutorial config YAML [required]
-u, --url <url>           Override Galaxy URL
--api-key <key>           Galaxy API key
--anthropic-key <key>     Anthropic API key
```

## Galaxy History API

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/histories/published?slug=X` | Resolve published history URL to ID |
| `GET /api/histories/{id}` | Get history metadata |
| `GET /api/histories/{id}/contents` | Get datasets (limited - misses collections) |
| `GET /api/jobs?history_id=X` | **Primary**: Get ALL executed jobs |
| `GET /api/jobs/{id}` | Get job details (tool_id, inputs, outputs) |

### History URL Formats Supported

```
https://usegalaxy.org/histories/view?id=abc123
https://usegalaxy.org/history/view/abc123
https://usegalaxy.org/u/username/h/history-slug  (published)
```

### Internal Tools Filtered Out

The following are excluded from tutorials (workflow infrastructure):
- `__MERGE_COLLECTION__`, `__RELABEL_FROM_FILE__`, `__FLATTEN__`
- `map_param_value`, `pick_value`, `compose_text_param`
- `param_value_from_file`
- Any tool starting with `__`
- Jobs with `state: skipped` or `state: error`

## Key Files

### `src/galaxy/history-client.ts`

Galaxy API client for history/jobs. Key types:

```typescript
interface ExecutedJob {
  id: string;
  tool_id: string;
  state: string;
  create_time: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

interface HistoryDetails {
  id: string;
  name: string;
  datasets: HistoryDataset[];
  jobs: ExecutedJob[];  // All executed jobs (filtered)
}
```

Key method: `getHistoryJobs(historyId)` - fetches all jobs via `/api/jobs?history_id=X`, filters out internal tools.

### `src/tutorial/history-enricher.ts`

Maps history jobs to workflow steps:

```typescript
class HistoryEnricher {
  // Uses history.jobs (from Jobs API) to build executed steps
  getExecutedSteps(): ExecutedStep[]

  // Legacy method for workflow-converter compatibility
  enrichSteps(): EnrichedStep[]
}
```

### `src/tutorial/workflow-converter.ts`

Converts workflow + history to TutorialConfig:

```typescript
// If historyData provided:
//   → HISTORY-DRIVEN: Only tools from history.jobs appear
// If no history:
//   → WORKFLOW-ONLY: All tool steps from workflow appear
```

### `src/tutorial/generator.ts`

Main orchestrator:
- `generateHandsOn()` - Creates hands-on blocks, calls AI for tool explanations
- `generateToolStep()` - Formats tool with params + screenshot
- `generateScreenshotStep()` - Captures/saves screenshots

### `src/galaxy/client.ts`

Playwright-based browser automation:

```typescript
class GalaxyClient {
  init()                    // Launch headless Chromium (1920x1080)
  loginWithApiKey(key)      // Authenticate via sessionStorage + cookie
  openTool(toolId)          // Navigate to tool URL, wait for form
  captureScreenshot(opts)   // Element or full-page screenshot
}
```

## TutorialConfig Format

Intermediate YAML config matching GTN's tutorial structure:

```yaml
metadata:
  title: "RNA-seq Analysis"
  questions: ["What does this workflow do?"]
  objectives: ["Learn to run this workflow"]
  level: Intermediate
  contributions:
    authorship: ["username"]

galaxy:
  url: https://usegalaxy.org
  api_key: <key>

ai:
  provider: anthropic
  generate_explanations: true

output:
  tutorial_dir: ./output
  images_dir: ./output/images

sections:
  - id: intro
    title: Introduction
    type: intro
    content:
      - type: text
        text: "Workflow description..."

  - id: fastp
    title: fastp
    type: hands_on
    steps:
      - type: tool_run
        tool:
          tool_id: toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/0.24.0+galaxy3
          name: fastp
          params: []
          screenshot:
            filename: fastp.png
            selector: "#center"
```

## GTN Tutorial Format

Generated tutorials follow [GTN kramdown format](https://training.galaxyproject.org/training-material/topics/contributing/tutorials/create-new-tutorial-content/tutorial.html):

```markdown
---
layout: tutorial_hands_on
title: RNA-seq Analysis
questions:
- What does this workflow do?
objectives:
- Learn to run this workflow
---

# Introduction

This workflow...

> <agenda-title></agenda-title>
> 1. TOC
> {:toc}
{: .agenda}

## fastp

> <hands-on-title>fastp</hands-on-title>
>
> **fastp** performs adapter trimming and quality filtering...
>
> 1. **fastp** {% icon tool %} with the following parameters:
>
> ![fastp.png](images/fastp.png)
{: .hands_on}
```

Block types: `{: .hands_on}`, `{: .details}`, `{: .agenda}`, `{: .tip}`, `{: .warning}`

## Development

```bash
# Run in development mode
npx tsx src/cli.ts <command> [options]

# Build for production
npm run build

# Run built version
npm start <command> [options]
```

## Troubleshooting

### "Found N datasets, 0 jobs"

The history URL may be wrong or the API key doesn't have access. Verify:
```bash
curl -H "x-api-key: YOUR_KEY" \
  "https://usegalaxy.org/api/jobs?history_id=YOUR_HISTORY_ID"
```

### Published history not resolving

Published history resolution tries multiple endpoints. If failing, use direct history ID URL:
```
https://usegalaxy.org/histories/view?id=HISTORY_ID
```

### Missing tools in tutorial

Collections (dataset_collection) don't expose `creating_job` directly. The fix was to use `/api/jobs?history_id=X` instead of tracing dataset provenance.

### Screenshot capture fails

Ensure Galaxy is accessible and API key is valid. Tool forms require authentication for some parameters.

### Tool form timeout

Galaxy server slow or tool ID wrong. Check tool exists on target Galaxy.

### No AI text

Missing `ANTHROPIC_API_KEY` or `--anthropic-key`. Check `ai:` section in config.

## Context for Claude

When re-establishing context on a new machine, key points:

1. **Primary goal**: Generate GTN tutorials from Galaxy workflows + histories
2. **Key insight**: Use Jobs API (`/api/jobs?history_id=X`) not dataset provenance
3. **Why**: Dataset provenance misses collections; Jobs API shows ALL executed tools
4. **Conditional workflows**: History shows what actually ran (skips conditional branches)
5. **Architecture**: workflow-converter → history-enricher → generator → client/AI
6. **API keys**: `.galaxy-api-key` and `.anthropic-api-key` files in project root

### Important Design Decisions

| Decision | Why |
|----------|-----|
| Jobs API over dataset provenance | Collections don't expose `creating_job`; Jobs API returns all 42 jobs vs 6 datasets |
| Filter internal tools | `map_param_value`, `__MERGE_COLLECTION__` etc. are workflow infrastructure |
| Separate hands-on per tool | GTN convention - each tool gets its own section |
| Selector `#center` | Captures tool form without Galaxy sidebars |

### Test Command

```bash
# RNA-seq PE workflow with published history (expects 26 tool steps)
curl -O https://raw.githubusercontent.com/iwc-workflows/rnaseq-pe/main/rnaseq-pe.ga

npx tsx src/cli.ts from-workflow \
  -w rnaseq-pe.ga \
  -o /tmp/config.yaml \
  -h "https://usegalaxy.org/u/cartman/h/unnamed-history-11" \
  --output-dir /tmp/tutorial \
  --images-dir /tmp/tutorial/images \
  --generate
```

Expected output: 26 tool steps including fastp, STAR (rna_star), StringTie, Cufflinks, FeatureCounts, MultiQC, RSeQC tools, Picard, samtools, fastqc, bedtools.

### File Locations

```
/home/anton/git/gtn-screenshot-bot/     # This project
/home/anton/git/training-material/      # GTN training materials
.galaxy-api-key                         # Galaxy API key (gitignored)
.anthropic-api-key                      # Anthropic API key (gitignored)
```

## Dependencies

- `playwright` - Browser automation (headless Chromium)
- `sharp` - Image manipulation
- `yaml` - YAML parsing
- `commander` - CLI
- TypeScript 5.3+
- Node.js 20+

## License

MIT
