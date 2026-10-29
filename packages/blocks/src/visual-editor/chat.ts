/**
 * Chat edits for the visual editor. The model receives the same view of the
 * document the layers panel shows (a bounded outline plus the selected node)
 * and answers with the same typed operations the canvas produces, so chat and
 * direct manipulation share validation, undo, and safety rules.
 */
import { z } from "zod";
import {
	MAX_OPERATIONS,
	type OutlineNode,
	type VisualOperation,
	VisualOperationListSchema,
} from "./core.ts";

const MAX_OUTLINE_CHARS = 24_000;
const MAX_SELECTION_CHARS = 16_000;

export const VISUAL_EDIT_SYSTEM_PROMPT = [
	"You edit an HTML document through typed operations. Reply with JSON only, no prose and no code fences.",
	'Shape: {"operations":[...],"summary":"one short sentence"}.',
	`Use at most ${MAX_OPERATIONS} operations. Node ids come from the outline; "root" is the page body.`,
	"Operations:",
	'{"kind":"insertHtml","parentId":id,"index":n,"html":fragment} inserts before the n-th child (use a large n to append).',
	'{"kind":"replaceHtml","nodeId":id,"html":fragment} replaces one element.',
	'{"kind":"move","nodeId":id,"parentId":id,"index":n}',
	'{"kind":"setText","nodeId":id,"text":string} for elements without child elements.',
	'{"kind":"setStyle","nodeId":id,"property":"css-property","value":string|null}',
	'{"kind":"setAttribute","nodeId":id,"name":string,"value":string|null}',
	'{"kind":"remove","nodeId":id} and {"kind":"duplicate","nodeId":id}',
	"Fragments use inline styles, semantic accessible HTML, alt text on images, and no scripts, event handlers, iframes, external fonts, or remote assets.",
	"Change only what the request asks for. Prefer the selected element when the request is ambiguous.",
	'If the request cannot be done with these operations, reply {"operations":[],"summary":"why"}.',
].join("\n");

export interface VisualEditPromptInput {
	outline: readonly OutlineNode[];
	request: string;
	selectedHtml?: string | null;
	selectedId?: string | null;
}

export function buildVisualEditPrompt(input: VisualEditPromptInput): string {
	const lines: string[] = [];
	let size = 0;
	for (const node of input.outline) {
		const line = `${"  ".repeat(node.depth)}${node.id} <${node.tag}>${node.label ? ` ${JSON.stringify(node.label)}` : ""}`;
		size += line.length + 1;
		if (size > MAX_OUTLINE_CHARS) {
			lines.push("… outline truncated");
			break;
		}
		lines.push(line);
	}
	const parts = [`Request: ${input.request.trim()}`, "", "Outline:", ...lines];
	if (input.selectedId && input.selectedHtml) {
		parts.push(
			"",
			`Selected: ${input.selectedId}`,
			input.selectedHtml.slice(0, MAX_SELECTION_CHARS)
		);
	}
	return parts.join("\n");
}

const ResponseSchema = z.object({
	operations: z.array(z.unknown()).max(MAX_OPERATIONS),
	summary: z.string().max(500).optional(),
});

export type VisualEditResponse =
	| { ok: true; operations: VisualOperation[]; summary: string }
	| { error: string; ok: false };

function extractJson(text: string): string {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Parse and validate a model reply. Nothing is applied here. */
export function parseVisualEditResponse(text: string): VisualEditResponse {
	let raw: unknown;
	try {
		raw = JSON.parse(extractJson(text));
	} catch {
		return {
			ok: false,
			error:
				"The model did not reply with edit operations. Try rephrasing the request.",
		};
	}
	const response = ResponseSchema.safeParse(raw);
	if (!response.success) {
		return {
			ok: false,
			error: "The model reply was not in the expected shape.",
		};
	}
	const summary = response.data.summary?.trim() ?? "";
	if (response.data.operations.length === 0) {
		return {
			ok: false,
			error: summary || "The model could not express that change as an edit.",
		};
	}
	const operations = VisualOperationListSchema.safeParse(
		response.data.operations
	);
	if (!operations.success) {
		const issue = operations.error.issues[0];
		return {
			ok: false,
			error: `The model proposed an invalid edit${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}.`,
		};
	}
	return {
		ok: true,
		operations: operations.data,
		summary: summary || "Applied the requested change.",
	};
}
