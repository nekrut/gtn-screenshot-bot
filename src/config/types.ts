export interface ScreenshotConfig {
  galaxy_url: string;
  tutorial: string;
  output_dir: string;
  credentials?: {
    username: string;
    password: string;
  };
  api_key?: string;
  prerequisites?: Prerequisite[];
  screenshots: Screenshot[];
}

export interface Prerequisite {
  name: string;
  datasets?: DatasetUpload[];
  collections?: CollectionCreate[];
}

export interface DatasetUpload {
  url: string;
  type: string;
  name?: string;
}

export interface CollectionCreate {
  name: string;
  type: 'list' | 'paired' | 'list:paired';
  elements: string[]; // dataset names
}

export interface Screenshot {
  id: string;
  description?: string;
  output: string;
  steps: Step[];
}

export type Step =
  | OpenToolStep
  | SetParamStep
  | ClickStep
  | WaitStep
  | CaptureStep
  | NavigateStep;

export interface OpenToolStep {
  action: 'open_tool';
  tool_id: string;
}

export interface SetParamStep {
  action: 'set_param';
  param: string;
  value: string | number | boolean;
}

export interface ClickStep {
  action: 'click';
  selector: string;
}

export interface WaitStep {
  action: 'wait';
  ms?: number;
  selector?: string;
}

export interface NavigateStep {
  action: 'navigate';
  url: string;
}

export interface CaptureStep {
  action: 'capture';
  selector?: string;
  fullPage?: boolean;
  annotations?: Annotation[];
}

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
  from: [number, number] | string; // coords or selector
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

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
