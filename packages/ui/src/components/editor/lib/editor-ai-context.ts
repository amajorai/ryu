import { replacePlaceholders } from "@platejs/ai";
import { serializeMd } from "@platejs/markdown";
import type { UIMessage } from "ai";
import {
	createSlateEditor,
	type Descendant,
	RangeApi,
	type SlateEditor,
	type TRange,
	type Value,
} from "platejs";
import { BaseEditorKit } from "../editor-base-kit.tsx";

/**
 * The document snapshot `@platejs/ai`'s `submitAIChat` / `aiChat.reload` send
 * as `body.ctx`. Plate expects a server route to turn it into the prompt; the
 * editor transport calls the Gateway directly, so it has to do that itself.
 */
export interface EditorAiRequestContext {
	children?: Value;
	selection?: TRange | null;
	toolName?: string | null;
}

const EDIT_GUIDANCE =
	"Apply the instruction to the content inside <Selection> only. Return ONLY the " +
	"rewritten <Selection> content as Markdown, keeping the same blocks in the same " +
	"order (one output block per input block).";
const SELECTION_GUIDANCE =
	"The instruction refers to the content inside <Selection>; <Document> is the " +
	"surrounding document for context.";
const CURSOR_GUIDANCE =
	"<Document> is the full document and <Block> is the block at the cursor.";

function tag(name: string, markdown: string): string {
	return `<${name}>\n${markdown.trim()}\n</${name}>`;
}

function serialize(editor: SlateEditor, value?: Descendant[]): string {
	return serializeMd(editor, value ? { value } : {});
}

/** Headless copy of the snapshot, so the live editor (which `submitAIChat` may already have undone) is never read. */
function createContextEditor(ctx: EditorAiRequestContext): SlateEditor {
	const editor = createSlateEditor({
		plugins: BaseEditorKit,
		value: ctx.children,
	});
	if (ctx.selection) {
		try {
			// Throws when the snapshot's range no longer resolves in its own value.
			editor.api.fragment(ctx.selection);
			editor.selection = ctx.selection;
		} catch {
			editor.selection = null;
		}
	}
	return editor;
}

/** The blocks `submitAIChat` stores as `chatNodes`, which `applyAISuggestions` diffs the reply against. */
function selectedBlocks(editor: SlateEditor, selection: TRange): Descendant[] {
	const highest = editor.api.blocks({ at: selection, mode: "highest" });
	if (highest.length > 1) {
		return highest.map(([node]) => node);
	}
	return editor.api.fragment(selection);
}

function buildContextText(
	editor: SlateEditor,
	toolName: string | null | undefined,
	documentAlreadyInPrompt: boolean
): string | null {
	const { selection } = editor;
	const isSelecting = !!selection && RangeApi.isExpanded(selection);
	const sections: string[] = [];

	if (toolName === "edit") {
		if (!isSelecting) {
			return null;
		}
		sections.push(
			tag("Selection", serialize(editor, selectedBlocks(editor, selection)))
		);
		sections.push(EDIT_GUIDANCE);
		return sections.join("\n\n");
	}

	if (!documentAlreadyInPrompt) {
		sections.push(tag("Document", serialize(editor)));
	}
	if (isSelecting) {
		sections.push(
			tag("Selection", serialize(editor, selectedBlocks(editor, selection)))
		);
		sections.push(SELECTION_GUIDANCE);
	} else if (selection) {
		const block = editor.api.block({ at: selection, highest: true });
		if (block) {
			sections.push(tag("Block", serialize(editor, [block[0]])));
		}
		sections.push(CURSOR_GUIDANCE);
	}
	return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Give the model the document text the editor AI command refers to: substitute
 * `{editor}` / `{block}` / `{selection}`-style placeholders in the latest user
 * message and prepend its `<Document>` / `<Block>` / `<Selection>` context.
 * Earlier messages and the input array are left untouched.
 */
export function applyEditorAiContext<M extends UIMessage>(
	messages: M[],
	ctx: EditorAiRequestContext | undefined
): M[] {
	if (!(ctx && Array.isArray(ctx.children) && ctx.children.length > 0)) {
		return messages;
	}
	let lastUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") {
			lastUserIndex = index;
			break;
		}
	}
	const lastUser = messages[lastUserIndex];
	if (!lastUser) {
		return messages;
	}

	const editor = createContextEditor(ctx);
	let documentAlreadyInPrompt = false;
	const parts = lastUser.parts.map((part) => {
		if (part.type !== "text") {
			return part;
		}
		if (part.text.includes("{editor}")) {
			documentAlreadyInPrompt = true;
		}
		return { ...part, text: replacePlaceholders(editor, part.text) };
	});

	const contextText = buildContextText(
		editor,
		ctx.toolName,
		documentAlreadyInPrompt
	);
	// SAFETY: a `{ type: "text" }` object is the AI SDK's TextUIPart, a member of every UIMessage part union.
	const contextPart = { type: "text", text: contextText } as M["parts"][number];
	const nextMessages = [...messages];
	nextMessages[lastUserIndex] = {
		...lastUser,
		parts: contextText ? [contextPart, ...parts] : parts,
	};
	return nextMessages;
}
