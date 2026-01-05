import sharp from 'sharp';
import { Annotation, BoxAnnotation, ArrowAnnotation, TextAnnotation, ElementBounds } from '../config/types';

const COLOR_MAP: Record<string, string> = {
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  orange: '#ff8800',
  yellow: '#ffff00',
  purple: '#8800ff',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  white: '#ffffff',
  black: '#000000',
};

function resolveColor(color: string): string {
  return COLOR_MAP[color.toLowerCase()] || color;
}

export async function annotateImage(
  imageBuffer: Buffer,
  annotations: Annotation[],
  getBounds: (selector: string) => Promise<ElementBounds | null>
): Promise<Buffer> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width || 1920;
  const height = metadata.height || 1080;

  // Build SVG overlay for annotations
  const svgParts: string[] = [];

  for (const annotation of annotations) {
    switch (annotation.type) {
      case 'box':
        const boxSvg = await renderBox(annotation, getBounds);
        if (boxSvg) svgParts.push(boxSvg);
        break;
      case 'arrow':
        const arrowSvg = await renderArrow(annotation, getBounds);
        if (arrowSvg) svgParts.push(arrowSvg);
        break;
      case 'text':
        const textSvg = renderText(annotation);
        if (textSvg) svgParts.push(textSvg);
        break;
    }
  }

  if (svgParts.length === 0) {
    return imageBuffer;
  }

  const svgOverlay = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="7"
                refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="currentColor"/>
        </marker>
      </defs>
      ${svgParts.join('\n')}
    </svg>
  `;

  return await image
    .composite([
      {
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0,
      },
    ])
    .toBuffer();
}

async function renderBox(
  annotation: BoxAnnotation,
  getBounds: (selector: string) => Promise<ElementBounds | null>
): Promise<string | null> {
  const bounds = await getBounds(annotation.selector);
  if (!bounds) {
    console.warn(`Box annotation: element not found for selector "${annotation.selector}"`);
    return null;
  }

  const color = resolveColor(annotation.color);
  const lineWidth = annotation.lineWidth || 3;
  const padding = 4;

  let svg = `
    <rect
      x="${bounds.x - padding}"
      y="${bounds.y - padding}"
      width="${bounds.width + padding * 2}"
      height="${bounds.height + padding * 2}"
      fill="none"
      stroke="${color}"
      stroke-width="${lineWidth}"
      rx="4"
    />
  `;

  if (annotation.label) {
    svg += `
      <text
        x="${bounds.x + bounds.width / 2}"
        y="${bounds.y - padding - 5}"
        fill="${color}"
        font-size="14"
        font-family="Arial, sans-serif"
        font-weight="bold"
        text-anchor="middle"
      >${annotation.label}</text>
    `;
  }

  return svg;
}

async function renderArrow(
  annotation: ArrowAnnotation,
  getBounds: (selector: string) => Promise<ElementBounds | null>
): Promise<string | null> {
  let fromX: number, fromY: number;
  let toX: number, toY: number;

  // Resolve "from" position
  if (Array.isArray(annotation.from)) {
    [fromX, fromY] = annotation.from;
  } else {
    const bounds = await getBounds(annotation.from);
    if (!bounds) {
      console.warn(`Arrow annotation: "from" element not found for selector "${annotation.from}"`);
      return null;
    }
    fromX = bounds.x + bounds.width / 2;
    fromY = bounds.y + bounds.height / 2;
  }

  // Resolve "to" position
  if (Array.isArray(annotation.to)) {
    [toX, toY] = annotation.to;
  } else {
    const bounds = await getBounds(annotation.to);
    if (!bounds) {
      console.warn(`Arrow annotation: "to" element not found for selector "${annotation.to}"`);
      return null;
    }
    toX = bounds.x + bounds.width / 2;
    toY = bounds.y + bounds.height / 2;
  }

  const color = resolveColor(annotation.color);
  const lineWidth = annotation.lineWidth || 3;

  return `
    <line
      x1="${fromX}" y1="${fromY}"
      x2="${toX}" y2="${toY}"
      stroke="${color}"
      stroke-width="${lineWidth}"
      marker-end="url(#arrowhead)"
      style="color: ${color}"
    />
  `;
}

function renderText(annotation: TextAnnotation): string {
  const [x, y] = annotation.position;
  const color = resolveColor(annotation.color || 'black');
  const fontSize = annotation.fontSize || 16;

  return `
    <text
      x="${x}" y="${y}"
      fill="${color}"
      font-size="${fontSize}"
      font-family="Arial, sans-serif"
    >${escapeXml(annotation.text)}</text>
  `;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
