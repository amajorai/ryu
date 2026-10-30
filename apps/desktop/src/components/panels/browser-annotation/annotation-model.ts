// Types and pure helpers for BrowserAnnotationSurface, split out of
// apps/desktop/src/components/panels/BrowserAnnotationSurface.tsx (which
// re-exports the public types) so that file stays under the size limit.

import type { CSSProperties } from "react";

export interface AnnotationRectStyle extends CSSProperties {
	"--annotation-height": string;
	"--annotation-left": string;
	"--annotation-top": string;
	"--annotation-width": string;
}

export interface BrowserRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

export interface BrowserStyleAdjust {
	background_color?: string;
	color?: string;
	font_family?: string;
	font_size?: string;
	font_weight?: string;
	letter_spacing?: string;
	line_height?: string;
	margin?: string;
	padding?: string;
}

export interface BrowserElementContext {
	attributes: Record<string, string>;
	component?: string;
	computed_styles: Record<string, string>;
	content_preview?: string;
	name?: string;
	rect: BrowserRect;
	ref?: string;
	role?: string;
	selector: string;
	tag: string;
	text?: string;
	xpath: string;
}

export interface BrowserWebMCPTool {
	annotations: {
		consequentialHint: boolean;
		debugging: boolean;
		readOnlyHint: boolean;
		untrustedContentHint: boolean;
	};
	description: string;
	input_schema: string;
	name: string;
	origin: string;
	title: string;
	tool_id: string;
}

export type BrowserAnnotationKind = "area" | "element" | "elements";

export interface BrowserAnnotation {
	comment: string;
	created_at: string;
	id: string;
	kind: BrowserAnnotationKind;
	rect: BrowserRect;
	style?: BrowserStyleAdjust;
	targets: BrowserElementContext[];
}

export interface BrowserContextResult {
	annotations: BrowserAnnotation[];
	page: { id: string; title: string; url: string };
	screenshot?: { encoding: "base64"; image: string; mime: "image/png" };
	selection?: {
		rect: BrowserRect;
		targets: BrowserElementContext[];
	};
	snapshot: {
		elements: Array<{
			depth: number;
			name?: string;
			props?: Record<string, boolean | number | string>;
			ref: string;
			role: string;
			value?: string;
		}>;
		snapshot_id: string;
		tab: { id: string; title: string; url: string };
		truncated: boolean;
	};
	viewport: {
		height: number;
		scroll_x: number;
		scroll_y: number;
		width: number;
	};
	webmcp_tools?: BrowserWebMCPTool[];
}

export interface BrowserAnnotationInput {
	comment: string;
	kind: BrowserAnnotationKind;
	rect: BrowserRect;
	selections?: BrowserRect[];
	style?: BrowserStyleAdjust;
}

export interface BrowserAnnotationSurfaceProps {
	askRyuPending?: boolean;
	context: BrowserContextResult | null;
	imageUrl: string | null;
	isAnnotating: boolean;
	onAnnotate: (
		input: BrowserAnnotationInput
	) => Promise<BrowserAnnotation | null>;
	onAskRyu: () => void;
	onClearAnnotations: () => Promise<void>;
	onContext: (
		selections: BrowserRect[]
	) => Promise<BrowserContextResult | null>;
	onDeleteAnnotation: (id: string) => Promise<void>;
	onToggleAnnotating: () => void;
}

export interface SpeechRecognitionResultLike {
	0?: { transcript?: string };
}

export interface SpeechRecognitionEventLike {
	results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionLike {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onend?: (() => void) | null;
	onerror?: (() => void) | null;
	onresult?: ((event: SpeechRecognitionEventLike) => void) | null;
	start: () => void;
	stop: () => void;
}

/** Complete private speech port consumed by the annotation recorder. */
export type BrowserAnnotationSpeechRecognition = SpeechRecognitionLike;

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/**
 * The Web Speech constructors this recorder reads. A local view rather than a
 * global `Window` augmentation: dependencies such as @assistant-ui/core already
 * augment `Window` with their own constructor types, and a second declaration
 * fails TS2717 in every program that loads both.
 */
export interface SpeechRecognitionWindow {
	SpeechRecognition?: SpeechRecognitionConstructor;
	webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export const MIN_AREA_SIZE = 8;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function rectFromPoints(
	start: { x: number; y: number },
	end: { x: number; y: number }
): BrowserRect {
	return {
		height: Math.abs(end.y - start.y),
		width: Math.abs(end.x - start.x),
		x: Math.min(start.x, end.x),
		y: Math.min(start.y, end.y),
	};
}

export function unionRects(rects: BrowserRect[]): BrowserRect | null {
	if (rects.length === 0) {
		return null;
	}
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { height: bottom - top, width: right - left, x: left, y: top };
}

export function describeTarget(target: BrowserElementContext): string {
	const label = target.name || target.text || target.content_preview;
	return label ? `${target.tag} · ${label}` : target.selector;
}

export function createRecognition(): SpeechRecognitionLike | null {
	if (!globalThis.window) {
		return null;
	}
	const speechWindow: SpeechRecognitionWindow & Window = window;
	const Constructor =
		speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
	return Constructor ? new Constructor() : null;
}

export function extractTranscript(event: SpeechRecognitionEventLike): string {
	const transcript: string[] = [];
	for (const result of Array.from(event.results)) {
		const text = result[0]?.transcript?.trim();
		if (text) {
			transcript.push(text);
		}
	}
	return transcript.join(" ");
}
