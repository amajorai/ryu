/**
 * Constants, operation schemas, and shared types of the visual editor core.
 */
import { z } from "zod";

export const NODE_ATTRIBUTE = "data-ryu-node";
export const ROOT_NODE_ID = "root";
export const MAX_OPERATIONS = 50;
export const MAX_FRAGMENT_BYTES = 200_000;

export const NODE_ID = /^(?:root|n[0-9]{1,7})$/;
const ATTRIBUTE_NAME = /^[a-z][a-z0-9_:.-]{0,63}$/;
const CSS_PROPERTY = /^(?:--[a-z0-9-]{1,62}|[a-z][a-z-]{0,62})$/;
export const UNSAFE_URL = /^\s*(?:javascript|vbscript|data:text\/html)/i;
export const UNSAFE_CSS =
	/expression\s*\(|javascript:|<\/|@import|url\s*\(\s*['"]?\s*(?:javascript|https?:)/i;
export const URL_ATTRIBUTES = new Set([
	"action",
	"formaction",
	"href",
	"ping",
	"poster",
	"src",
	"srcset",
	"xlink:href",
]);
/** Elements the editor never annotates, drags, or accepts in inserted HTML. */
export const NON_VISUAL = new Set([
	"BASE",
	"HEAD",
	"LINK",
	"META",
	"NOSCRIPT",
	"SCRIPT",
	"STYLE",
	"TEMPLATE",
	"TITLE",
]);
export const FORBIDDEN_FRAGMENT = new Set([
	...NON_VISUAL,
	"EMBED",
	"FRAME",
	"FRAMESET",
	"IFRAME",
	"OBJECT",
	// SVG animation can rewrite an `href` (or an `on*`) to a script URL after
	// the attribute check below has run.
	"ANIMATE",
	"ANIMATEMOTION",
	"ANIMATETRANSFORM",
	"SET",
]);
export const VOID = new Set([
	"AREA",
	"BR",
	"COL",
	"EMBED",
	"HR",
	"IMG",
	"INPUT",
	"SOURCE",
	"TRACK",
	"WBR",
]);
/** Elements whose children are not free-form layout. */
export const LEAF_CONTENT = new Set([
	"BUTTON",
	"CANVAS",
	"SELECT",
	"SVG",
	"TEXTAREA",
	"VIDEO",
	"AUDIO",
	"PICTURE",
]);

const nodeId = z.string().regex(NODE_ID, "Unknown node id");
const index = z.number().int().min(0).max(10_000);
const fragment = z.string().min(1).max(MAX_FRAGMENT_BYTES);

export const VisualOperationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("insertHtml"),
			parentId: nodeId,
			index,
			html: fragment,
		})
		.strict(),
	z.object({ kind: z.literal("replaceHtml"), nodeId, html: fragment }).strict(),
	z
		.object({ kind: z.literal("move"), nodeId, parentId: nodeId, index })
		.strict(),
	z
		.object({
			kind: z.literal("setText"),
			nodeId,
			text: z.string().max(20_000),
		})
		.strict(),
	z
		.object({
			kind: z.literal("setStyle"),
			nodeId,
			property: z.string().regex(CSS_PROPERTY, "Invalid CSS property"),
			value: z.string().max(2000).nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("setAttribute"),
			nodeId,
			name: z.string().regex(ATTRIBUTE_NAME, "Invalid attribute name"),
			value: z.string().max(4000).nullable(),
		})
		.strict(),
	z.object({ kind: z.literal("remove"), nodeId }).strict(),
	z.object({ kind: z.literal("duplicate"), nodeId }).strict(),
]);

export type VisualOperation = z.infer<typeof VisualOperationSchema>;

export const VisualOperationListSchema = z
	.array(VisualOperationSchema)
	.min(1)
	.max(MAX_OPERATIONS);

export interface HtmlParser {
	parseFromString(source: string, type: "text/html"): Document;
}

export type EditResult =
	| { affected: string[]; html: string; ok: true }
	| { error: string; ok: false };

export interface OutlineNode {
	childCount: number;
	depth: number;
	id: string;
	label: string;
	parentId: string | null;
	tag: string;
}

export type DropPosition = "after" | "before" | "inside";

export interface DropTarget {
	index: number;
	parentId: string;
}
