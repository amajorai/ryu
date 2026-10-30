import type { CSSProperties } from "react";
import { DROP_ATTRIBUTE } from "./canvas.ts";
import { NODE_ATTRIBUTE } from "./core.ts";

export type VisualEditorComplete = (input: {
	prompt: string;
	system: string;
}) => Promise<string>;

export interface VisualEditorProps {
	/** The host model, when one is connected. Chat is disabled without it. */
	complete?: VisualEditorComplete;
	disabled?: boolean;
	/** Clean HTML from the host. A change from outside resets history. */
	html: string;
	/** Receives clean HTML (no editor ids) after every successful edit. */
	onChange: (html: string) => void;
}

export const NODE_MIME = "application/x-ryu-node";
export const BLOCK_MIME = "application/x-ryu-block";
export const MAX_HISTORY = 50;

export type Viewport = "desktop" | "tablet" | "mobile";
export const VIEWPORT_WIDTH = {
	desktop: undefined,
	tablet: 820,
	mobile: 390,
} satisfies Record<Viewport, number | undefined>;

export const STYLE_FIELDS = [
	["color", "Text color"],
	["background-color", "Background"],
	["font-size", "Font size"],
	["font-weight", "Font weight"],
	["text-align", "Alignment"],
	["padding", "Padding"],
	["margin", "Margin"],
	["gap", "Gap"],
	["border-radius", "Corner radius"],
	["width", "Width"],
	["max-width", "Max width"],
] as const;

export const ATTRIBUTE_FIELDS = {
	a: [
		["href", "Link"],
		["aria-label", "Accessible label"],
	],
	img: [
		["src", "Image source"],
		["alt", "Alt text"],
	],
	button: [["aria-label", "Accessible label"]],
	input: [
		["placeholder", "Placeholder"],
		["aria-label", "Accessible label"],
	],
} satisfies Record<string, readonly (readonly [string, string])[]>;

export interface VisualLayoutStyle extends CSSProperties {
	"--visual-canvas-width"?: string;
	"--visual-layer-indent"?: string;
}
export function attributeFields(tag: string) {
	switch (tag) {
		case "a":
			return ATTRIBUTE_FIELDS.a;
		case "img":
			return ATTRIBUTE_FIELDS.img;
		case "button":
			return ATTRIBUTE_FIELDS.button;
		case "input":
			return ATTRIBUTE_FIELDS.input;
		default:
			return [];
	}
}

export const parser = (): DOMParser => new DOMParser();

export function nodeFromEvent(target: EventTarget | null): Element | null {
	// SAFETY: all five callers pass native DOM targets from this iframe Document.
	// nodeType 1 selects Element; other Nodes retain the parentElement fallback.
	const element =
		target && (target as Node).nodeType === 1
			? (target as Element)
			: ((target as Node | null)?.parentElement ?? null);
	return element?.closest(`[${NODE_ATTRIBUTE}]`) ?? null;
}

export function clearDropMarks(document: Document | null | undefined): void {
	for (const element of document?.querySelectorAll(`[${DROP_ATTRIBUTE}]`) ??
		[]) {
		element.removeAttribute(DROP_ATTRIBUTE);
	}
}
