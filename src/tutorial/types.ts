// GTN Tutorial Types
// Based on: https://training.galaxyproject.org/training-material/topics/contributing/tutorials/create-new-tutorial-content/tutorial.html

export interface TutorialConfig {
  // Metadata
  metadata: TutorialMetadata;

  // Galaxy configuration
  galaxy: GalaxyConfig;

  // AI configuration for text generation
  ai?: AIConfig;

  // Tutorial content sections
  sections: Section[];

  // Output configuration
  output: OutputConfig;
}

export interface TutorialMetadata {
  title: string;
  layout?: string; // default: tutorial_hands_on
  zenodo_link?: string;
  questions: string[];
  objectives: string[];
  time_estimation?: string;
  level?: 'Introductory' | 'Intermediate' | 'Advanced';
  key_points?: string[]; // Can be auto-generated
  subtopic?: string;
  priority?: number;

  // Contributions - detailed credit for different types
  contributions: TutorialContributions;

  // Abbreviations - auto-expand on first use with {ABBREV} syntax
  abbreviations?: Record<string, string>;

  // Example histories for learners
  answer_histories?: HistoryLink[];
  input_histories?: HistoryLink[];

  // Tags for filtering/searching
  tags?: string[];
}

export interface TutorialContributions {
  authorship: string[];
  editing?: string[];
  funding?: string[];
  testing?: string[];
  ux?: string[];
  infrastructure?: string[];
}

export interface HistoryLink {
  label: string;
  history: string; // URL to Galaxy history
  date?: string;   // ISO date string
}

export interface GalaxyConfig {
  url: string;
  credentials?: {
    username: string;
    password: string;
  };
  api_key?: string;
}

export interface AIConfig {
  provider: 'anthropic' | 'openai';
  api_key?: string; // Can use env var
  model?: string;
  generate_explanations?: boolean;
  generate_details_blocks?: boolean;
  generate_key_points?: boolean;
}

export interface OutputConfig {
  tutorial_dir: string; // Where to write tutorial.md
  images_dir: string;   // Where to write screenshots
  image_format?: 'png' | 'svg'; // svg wraps png with annotations
}

export interface Section {
  id: string;
  title: string;
  level?: 1 | 2 | 3; // Heading level (default: 2)
  type: 'intro' | 'hands_on' | 'explanation' | 'conclusion';

  // Content elements
  content?: ContentElement[];

  // For hands_on sections
  steps?: HandsOnStep[];

  // Optional details blocks to include
  details_blocks?: DetailsBlock[];

  // Context from history for AI generation (e.g., "Processing sample_R1.fastq")
  history_context?: string;
}

export type ContentElement =
  | TextContent
  | ImageContent
  | TableContent
  | CodeBlockContent
  | ToolMentionContent
  | QuestionContent
  | QuoteContent
  | TipContent
  | WarningContent
  | SnippetContent;

export interface TextContent {
  type: 'text';
  text?: string;
  generate?: boolean; // AI generates based on context
  prompt?: string;    // Custom prompt for AI
}

export interface ImageContent {
  type: 'image';
  src: string;
  alt: string;
  caption?: string;
}

export interface TableContent {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export interface CodeBlockContent {
  type: 'code';
  language?: string;
  code: string;
}

export interface ToolMentionContent {
  type: 'tool_mention';
  tool_id: string;
  name: string;
}

export interface QuestionContent {
  type: 'question';
  title?: string;
  questions: string[];
  solution?: {
    title?: string;
    answers: string[];
  };
}

export interface QuoteContent {
  type: 'quote';
  text: string;
  cite?: string;   // URL
  author?: string;
}

export interface TipContent {
  type: 'tip';
  title: string;
  text: string;
}

export interface WarningContent {
  type: 'warning';
  title: string;
  text: string;
}

export interface SnippetContent {
  type: 'snippet';
  path: string;              // Path to snippet file, e.g., "faqs/galaxy/histories_create_new.md"
  box_type?: BoxType | 'none';
}

export interface HandsOnStep {
  id?: string;
  type: 'instruction' | 'tool_run' | 'screenshot' | 'note';

  // For instruction type
  text?: string;

  // For tool_run type
  tool?: ToolStep;

  // For screenshot type
  screenshot?: ScreenshotStep;

  // For note type (comment blocks)
  note?: NoteStep;
}

export interface ToolStep {
  type?: 'tool_run';  // For compatibility with HandsOnStep pattern
  tool_id: string;
  name: string;
  version?: string;
  params: ToolParam[];
  screenshot?: ScreenshotStep;
  output_description?: string;

  // Input datasets from history to select in tool form
  input_datasets?: InputDatasetRef[];

  // Full job params for form filling (from history-based generation)
  job_params?: import('../galaxy/job-params').JobFullParams;

  // Resolved collection inputs: param_name -> { hid, name }
  input_collections?: Record<string, { hid: number; name: string }>;

  // Resolved dataset inputs: param_name -> { hid, name }
  resolved_inputs?: Record<string, { hid: number; name: string }>;

  // For single-dataset output tools: use /tool_runner/rerun?id=<dataset_id>
  // This shows correct inputs without needing text replacement
  rerun_dataset_id?: string;
}

export interface InputDatasetRef {
  param_label: string;
  dataset_name: string;
  dataset_id?: string;
  extension?: string;
}

// Parameter type icons available in GTN
export type ParamIcon =
  | 'param-text'      // text input
  | 'param-file'      // single file input
  | 'param-files'     // multiple files or collection
  | 'param-select'    // dropdown/select
  | 'param-check'     // checkbox
  | 'param-toggle'    // toggle button
  | 'param-repeat';   // repeat section

export interface ToolParam {
  label: string;
  value: string;
  icon?: ParamIcon;   // Parameter type icon
  annotation?: {
    color: string;
    type: 'outline' | 'arrow';
  };
  // For nested params (inside repeat sections)
  children?: ToolParam[];
}

export interface ScreenshotStep {
  filename: string;
  selector?: string;
  fullPage?: boolean;
  caption?: string;
  annotations?: ScreenshotAnnotation[];

  // Actions to perform before screenshot
  pre_actions?: PreAction[];
}

export interface PreAction {
  action: 'click' | 'wait' | 'scroll' | 'set_param';
  selector?: string;
  value?: string;
  ms?: number;
}

export interface ScreenshotAnnotation {
  type: 'box' | 'arrow' | 'text';
  selector?: string;
  from?: [number, number] | string;
  to?: [number, number] | string;
  position?: [number, number];
  color: string;
  text?: string;
  label?: string;
}

// All GTN box types
export type BoxType =
  | 'hands_on'
  | 'tip'
  | 'comment'
  | 'details'
  | 'question'
  | 'warning'
  | 'quote'
  | 'agenda'
  | 'code-in'
  | 'code-out';

export interface NoteStep {
  title: string;
  type: 'comment' | 'tip' | 'warning' | 'question';
  text: string;
}

// Question box with optional solution
export interface QuestionBlock {
  title?: string;
  questions: string[];
  solution?: {
    title?: string;
    answers: string[];
  };
}

// Quote box with optional citation
export interface QuoteBlock {
  text: string;
  cite?: string;   // URL
  author?: string;
}

export interface DetailsBlock {
  title: string;
  generate?: boolean; // AI generates content
  topic?: string;     // Topic for AI to explain
  content?: string;   // Static content
  images?: ImageContent[];
}

// Recording import types (for DevTools recorder JSON)
export interface RecordingImport {
  source: string; // Path to recording JSON
  tutorial_metadata: TutorialMetadata;
  section_markers?: SectionMarker[];
}

export interface SectionMarker {
  step_index: number;
  section_title: string;
  section_type: Section['type'];
}

// Generated tutorial output
export interface GeneratedTutorial {
  frontmatter: string;
  content: string;
  images: GeneratedImage[];
}

export interface GeneratedImage {
  filename: string;
  data: Buffer;
}

// Element bounds for screenshot annotations
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Annotation types for image markup
export type Annotation = BoxAnnotation | ArrowAnnotation | TextAnnotation;

export interface BoxAnnotation {
  type: 'box';
  selector: string;
  color: string;
  label?: string;
  lineWidth?: number;
}

export interface ArrowAnnotation {
  type: 'arrow';
  from: [number, number] | string;
  to: [number, number] | string;
  color: string;
  lineWidth?: number;
}

export interface TextAnnotation {
  type: 'text';
  position: [number, number];
  text: string;
  color?: string;
  fontSize?: number;
}
