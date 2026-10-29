"use client";

import { LinkPlugin } from "@platejs/link/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { MentionPlugin } from "@platejs/mention/react";
import { AlignKit } from "@ryu/ui/components/editor/plugins/align-kit.tsx";
import { AutoformatKit } from "@ryu/ui/components/editor/plugins/autoformat-kit.tsx";
import { BasicBlocksKit } from "@ryu/ui/components/editor/plugins/basic-blocks-kit.tsx";
import { BasicMarksKit } from "@ryu/ui/components/editor/plugins/basic-marks-kit.tsx";
import { CalloutKit } from "@ryu/ui/components/editor/plugins/callout-kit.tsx";
import { CodeBlockKit } from "@ryu/ui/components/editor/plugins/code-block-kit.tsx";
import { ColumnKit } from "@ryu/ui/components/editor/plugins/column-kit.tsx";
import { DateKit } from "@ryu/ui/components/editor/plugins/date-kit.tsx";
import { EmojiKit } from "@ryu/ui/components/editor/plugins/emoji-kit.tsx";
import { ExitBreakKit } from "@ryu/ui/components/editor/plugins/exit-break-kit.tsx";
import { FontKit } from "@ryu/ui/components/editor/plugins/font-kit.tsx";
import { LineHeightKit } from "@ryu/ui/components/editor/plugins/line-height-kit.tsx";
import { LinkKit } from "@ryu/ui/components/editor/plugins/link-kit.tsx";
import { ListKit } from "@ryu/ui/components/editor/plugins/list-kit.tsx";
import { MarkdownKit } from "@ryu/ui/components/editor/plugins/markdown-kit.tsx";
import { MathKit } from "@ryu/ui/components/editor/plugins/math-kit.tsx";
import { MediaKit } from "@ryu/ui/components/editor/plugins/media-kit.tsx";
import { TableKit } from "@ryu/ui/components/editor/plugins/table-kit.tsx";
import { TocKit } from "@ryu/ui/components/editor/plugins/toc-kit.tsx";
import { ToggleKit } from "@ryu/ui/components/editor/plugins/toggle-kit.tsx";
import { WikiLinkKit } from "@ryu/ui/components/editor/plugins/wikilink-kit.tsx";
import {
	Editor,
	EditorContainer,
} from "@ryu/ui/components/editor/ui/editor.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	KEYS,
	setValue,
	type TMentionElement,
	TrailingBlockPlugin,
} from "platejs";
import type { PlateElementProps } from "platejs/react";
import { Plate, PlateElement, usePlateEditor } from "platejs/react";
import type {
	ClipboardEvent,
	DragEvent,
	KeyboardEvent,
	ReactNode,
	RefObject,
} from "react";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import {
	type ComposerMentionItem,
	exportMentionMarkdown,
	importMentionMarkdown,
} from "./composer-mention-markdown.ts";
import { moveMention } from "./composer-mention-move.ts";
import editorStyles from "./editor-lint.module.css";

export type { ComposerMentionItem } from "./composer-mention-markdown.ts";

export interface ComposerEditorProps {
	disabled?: boolean;
	editorRef?: RefObject<HTMLDivElement | null>;
	markdown: string;
	mentionItems?: ComposerMentionItem[];
	mentionRenderer?: (label: string, item?: ComposerMentionItem) => ReactNode;
	onChange: (markdown: string) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
	onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
	placeholder?: string;
}

interface ComposerMentionContextValue {
	items: ComposerMentionItem[];
	renderer?: ComposerEditorProps["mentionRenderer"];
}

const ComposerMentionContext = createContext<ComposerMentionContextValue>({
	items: [],
});

function ComposerMentionElement(props: PlateElementProps<TMentionElement>) {
	const { items, renderer } = useContext(ComposerMentionContext);
	const value = String(props.element.value ?? "").replace(/^@/, "");
	const item = items.find(
		(candidate) => candidate.label === value || candidate.id === value
	);
	const label = item?.label ?? value;
	const content = renderer ? renderer(`@${label}`, item) : `@${label}`;

	return (
		<PlateElement
			{...props}
			// `draggable` lets Slate move the chip natively: a drag selects the void
			// and a drop elsewhere in the editor removes it from its old spot.
			attributes={{
				...props.attributes,
				contentEditable: false,
				"data-slate-value": value,
				draggable: true,
			}}
			className="inline-block cursor-grab align-baseline active:cursor-grabbing"
		>
			{content}
		</PlateElement>
	);
}

const ComposerMentionKit = [
	MentionPlugin.configure({
		options: {
			triggerPreviousCharPattern: /^$|^[\s"']$/,
		},
	}).withComponent(ComposerMentionElement),
];

const ComposerEditorKit = [
	...BasicBlocksKit,
	...CodeBlockKit,
	...TableKit,
	...ToggleKit,
	...TocKit,
	...MediaKit,
	...CalloutKit,
	...ColumnKit,
	...MathKit,
	...DateKit,
	...LinkKit,
	...ComposerMentionKit,
	...WikiLinkKit,
	...BasicMarksKit,
	...FontKit,
	...ListKit,
	...AlignKit,
	...LineHeightKit,
	...AutoformatKit,
	...EmojiKit,
	...ExitBreakKit,
	TrailingBlockPlugin,
	...MarkdownKit,
];

// Plate serializes the empty text nodes around an inline mention as U+200B;
// consume them with the link so `@label` stays a whitespace-delimited token.
const MENTION_LINK_RE = /\u200B?\[([^\]]+)\]\(mention:([^\s)]+)\)\u200B?/g;

function escapeMarkdownText(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("[", "\\[")
		.replaceAll("]", "\\]");
}

export function mentionMarkdown(
	value: string,
	items: ComposerMentionItem[]
): string {
	const candidates = items
		.flatMap((item) => [
			{ item, token: `@${item.label}` },
			...(item.id && item.id !== item.label
				? [{ item, token: `@${item.id}` }]
				: []),
		])
		.sort((left, right) => right.token.length - left.token.length);
	if (candidates.length === 0) {
		return value;
	}

	let output = "";
	let cursor = 0;
	while (cursor < value.length) {
		let match:
			| { end: number; item: ComposerMentionItem; start: number; token: string }
			| undefined;
		for (let index = cursor; index < value.length; index += 1) {
			if (index > 0 && !/\s/.test(value[index - 1] ?? "")) {
				continue;
			}
			const candidate = candidates.find(({ token }) =>
				value.startsWith(token, index)
			);
			if (!candidate) {
				continue;
			}
			const end = index + candidate.token.length;
			const next = value[end];
			if (next && !/[\s.,;:!?)]/.test(next)) {
				continue;
			}
			match = {
				end,
				item: candidate.item,
				start: index,
				token: candidate.token,
			};
			break;
		}
		if (!match) {
			output += value.slice(cursor);
			break;
		}
		output += value.slice(cursor, match.start);
		const mentionId = encodeURIComponent(match.item.id ?? match.item.label)
			.replaceAll("(", "%28")
			.replaceAll(")", "%29");
		output += `[${escapeMarkdownText(match.token)}](mention:${mentionId})`;
		cursor = match.end;
	}
	return output;
}

export function serializeComposerMarkdown(markdown: string): string {
	return markdown.replace(MENTION_LINK_RE, (_match, displayText: string) => {
		const clean = displayText.replaceAll("**", "");
		return clean.startsWith("@") ? clean : `@${clean}`;
	});
}

export function ComposerEditor({
	disabled = false,
	editorRef,
	markdown,
	mentionItems = [],
	mentionRenderer,
	onChange,
	onKeyDown,
	onPaste,
	placeholder,
}: ComposerEditorProps) {
	const mentionContext = useMemo(
		() => ({ items: mentionItems, renderer: mentionRenderer }),
		[mentionItems, mentionRenderer]
	);
	const editor = usePlateEditor({
		plugins: ComposerEditorKit,
		value: (ed) =>
			ed
				.getApi(MarkdownPlugin)
				.markdown.deserialize(
					mentionMarkdown(
						importMentionMarkdown(markdown, mentionItems),
						mentionItems
					)
				),
	});
	const lastMarkdownRef = useRef(markdown);
	// A dragged mention chip is moved here rather than by Slate's own drop, which
	// re-inserts the fragment verbatim: a chip dropped against a word or another
	// chip then serializes as `a@b` and is lost when the draft round-trips
	// through Markdown. Slate also only accepts a drop over another void, so
	// `dragover` is accepted anywhere in the editor while a chip is in flight.
	const draggedMentionRef = useRef<TMentionElement | null>(null);
	const handleMentionDragStart = (event: DragEvent<HTMLDivElement>) => {
		const element =
			event.target instanceof Element
				? event.target.closest("[data-slate-value]")
				: null;
		const node = element ? editor.api.toSlateNode(element) : undefined;
		draggedMentionRef.current =
			node && "type" in node && node.type === editor.getType(KEYS.mention)
				? (node as TMentionElement)
				: null;
	};
	const handleMentionDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (draggedMentionRef.current) {
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
		}
	};
	// Returns `true` once the drop is ours: Plate skips Slate's own drop only
	// when a props handler returns `true`, not on `preventDefault`.
	const handleMentionDrop = (event: DragEvent<HTMLDivElement>): boolean => {
		const mention = draggedMentionRef.current;
		draggedMentionRef.current = null;
		if (!mention) {
			return false;
		}
		event.preventDefault();
		const from = editor.api.findPath(mention);
		const range = editor.api.findEventRange(event);
		if (!(from && range)) {
			return true;
		}
		const dropPath = range.anchor.path;
		const droppedOnItself = from.every(
			(part, depth) => dropPath[depth] === part
		);
		if (droppedOnItself) {
			return true;
		}
		const placed = moveMention(editor, mention, from, range.anchor);
		if (!placed) {
			return true;
		}
		const caret = editor.api.after(placed);
		editor.tf.focus();
		if (caret) {
			editor.tf.select(caret);
		}
		return true;
	};

	useEffect(() => {
		if (markdown === lastMarkdownRef.current) {
			return;
		}
		const next = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(
				mentionMarkdown(
					importMentionMarkdown(markdown, mentionItems),
					mentionItems
				)
			);
		setValue(editor, next);
		lastMarkdownRef.current = markdown;
	}, [editor, markdown, mentionItems]);

	return (
		<ComposerMentionContext.Provider value={mentionContext}>
			<Plate
				editor={editor}
				onChange={({ editor: changedEditor }) => {
					const next = serializeComposerMarkdown(
						changedEditor.getApi(MarkdownPlugin).markdown.serialize()
					);
					lastMarkdownRef.current = next;
					onChange(next);
				}}
			>
				<div
					onCopy={(event) => {
						const clipboardText = event.clipboardData.getData("text/plain");
						const selectedText =
							clipboardText || window.getSelection()?.toString() || "";
						const markdown = exportMentionMarkdown(selectedText, mentionItems);
						if (markdown === selectedText) {
							return;
						}
						event.preventDefault();
						event.clipboardData.setData("text/plain", markdown);
					}}
				>
					<EditorContainer
						className={cn(
							cn(
								"min-h-[40px] overflow-visible rounded-xl border-0 bg-transparent shadow-none",
								disabled && "cursor-not-allowed opacity-50"
							),
							editorStyles.editorcomposerEditor1
						)}
						variant="comment"
					>
						<Editor
							className="max-h-[240px] min-h-[40px] overflow-y-auto px-0 py-1.5 text-[14px] leading-[1.6]"
							disabled={disabled}
							onDragEnd={() => {
								draggedMentionRef.current = null;
							}}
							onDragOver={handleMentionDragOver}
							onDragStart={handleMentionDragStart}
							onDrop={handleMentionDrop}
							onKeyDown={onKeyDown}
							onPaste={(event) => {
								onPaste?.(event);
								if (event.defaultPrevented) {
									return;
								}
								const pastedText = event.clipboardData.getData("text/plain");
								const importedText = importMentionMarkdown(
									pastedText,
									mentionItems
								);
								if (importedText !== pastedText) {
									event.preventDefault();
									const fragment = editor
										.getApi(MarkdownPlugin)
										.markdown.deserialize(
											mentionMarkdown(importedText, mentionItems)
										);
									editor.tf.insertFragment(fragment);
									return;
								}
								// Plate's synthetic paste path can leave the caret just after
								// a newly-created link, so the floating link controls never
								// enter edit mode. Re-anchor to the inserted link after the
								// plugin has applied the paste; normal typing is unaffected.
								window.setTimeout(() => {
									const entry = editor.api
										.nodes({
											at: [],
											match: { type: editor.getType(KEYS.link) },
											mode: "all",
										})
										.next().value;
									if (entry) {
										editor.tf.select(editor.api.start(entry[1]));
										editor
											.getApi(LinkPlugin)
											.floatingLink.show("edit", editor.id);
									}
								}, 0);
							}}
							placeholder={placeholder}
							ref={editorRef}
							variant="none"
						/>
					</EditorContainer>
				</div>
			</Plate>
		</ComposerMentionContext.Provider>
	);
}
