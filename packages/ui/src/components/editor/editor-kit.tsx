"use client";

import type { UnifiedProvider } from "@platejs/yjs";
import { YjsPlugin } from "@platejs/yjs/react";
import { AIKit } from "@ryu/ui/components/editor/plugins/ai-kit.tsx";
import { AlignKit } from "@ryu/ui/components/editor/plugins/align-kit.tsx";
import { AutoformatKit } from "@ryu/ui/components/editor/plugins/autoformat-kit.tsx";
import { BasicBlocksKit } from "@ryu/ui/components/editor/plugins/basic-blocks-kit.tsx";
import { BasicMarksKit } from "@ryu/ui/components/editor/plugins/basic-marks-kit.tsx";
import { BlockMenuKit } from "@ryu/ui/components/editor/plugins/block-menu-kit.tsx";
import { BlockPlaceholderKit } from "@ryu/ui/components/editor/plugins/block-placeholder-kit.tsx";
import { CalloutKit } from "@ryu/ui/components/editor/plugins/callout-kit.tsx";
import { CodeBlockKit } from "@ryu/ui/components/editor/plugins/code-block-kit.tsx";
import { ColumnKit } from "@ryu/ui/components/editor/plugins/column-kit.tsx";
import { CommentKit } from "@ryu/ui/components/editor/plugins/comment-kit.tsx";
import { CopilotKit } from "@ryu/ui/components/editor/plugins/copilot-kit.tsx";
import { CursorOverlayKit } from "@ryu/ui/components/editor/plugins/cursor-overlay-kit.tsx";
import { DateKit } from "@ryu/ui/components/editor/plugins/date-kit.tsx";
import { DiscussionKit } from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import { DndKit } from "@ryu/ui/components/editor/plugins/dnd-kit.tsx";
import { DocxKit } from "@ryu/ui/components/editor/plugins/docx-kit.tsx";
import { EmojiKit } from "@ryu/ui/components/editor/plugins/emoji-kit.tsx";
import { ExitBreakKit } from "@ryu/ui/components/editor/plugins/exit-break-kit.tsx";
import { FixedToolbarKit } from "@ryu/ui/components/editor/plugins/fixed-toolbar-kit.tsx";
import { FloatingToolbarKit } from "@ryu/ui/components/editor/plugins/floating-toolbar-kit.tsx";
import { FontKit } from "@ryu/ui/components/editor/plugins/font-kit.tsx";
import { LineHeightKit } from "@ryu/ui/components/editor/plugins/line-height-kit.tsx";
import { LinkKit } from "@ryu/ui/components/editor/plugins/link-kit.tsx";
import { ListKit } from "@ryu/ui/components/editor/plugins/list-kit.tsx";
import { MarkdownKit } from "@ryu/ui/components/editor/plugins/markdown-kit.tsx";
import { MathKit } from "@ryu/ui/components/editor/plugins/math-kit.tsx";
import { MediaKit } from "@ryu/ui/components/editor/plugins/media-kit.tsx";
import { MentionKit } from "@ryu/ui/components/editor/plugins/mention-kit.tsx";
import { SlashKit } from "@ryu/ui/components/editor/plugins/slash-kit.tsx";
import { SuggestionKit } from "@ryu/ui/components/editor/plugins/suggestion-kit.tsx";
import { TableKit } from "@ryu/ui/components/editor/plugins/table-kit.tsx";
import { TocKit } from "@ryu/ui/components/editor/plugins/toc-kit.tsx";
import { ToggleKit } from "@ryu/ui/components/editor/plugins/toggle-kit.tsx";
import { WikiLinkKit } from "@ryu/ui/components/editor/plugins/wikilink-kit.tsx";
import { RemoteCursorOverlay } from "@ryu/ui/components/editor/ui/remote-cursor-overlay.tsx";
import { TrailingBlockPlugin, type Value } from "platejs";
import { type TPlateEditor, useEditorRef } from "platejs/react";

export const EditorKit = [
	...CopilotKit,
	...AIKit,

	// Elements
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
	...MentionKit,
	...WikiLinkKit,

	// Marks
	...BasicMarksKit,
	...FontKit,

	// Block Style
	...ListKit,
	...AlignKit,
	...LineHeightKit,

	// Collaboration
	...DiscussionKit,
	...CommentKit,
	...SuggestionKit,

	// Editing
	...SlashKit,
	...AutoformatKit,
	...CursorOverlayKit,
	...BlockMenuKit,
	...DndKit,
	...EmojiKit,
	...ExitBreakKit,
	TrailingBlockPlugin,

	// Parsers
	...DocxKit,
	...MarkdownKit,

	// UI
	...BlockPlaceholderKit,
	...FixedToolbarKit,
	...FloatingToolbarKit,
];

export type MyEditor = TPlateEditor<Value, (typeof EditorKit)[number]>;

export const useEditor = () => useEditorRef<MyEditor>();

/** Awareness metadata published for the local user's caret in a collab room. */
export interface CollabCursor {
	color: string;
	name: string;
}

/**
 * Build the editor plugin list for a COLLABORATIVE document: the standard
 * {@link EditorKit} plus `YjsPlugin` bound to a pre-instantiated
 * {@link UnifiedProvider} (our `RyuYjsProvider`, which syncs the shared
 * `Y.Doc`/`Awareness` over Core's realtime ws).
 *
 * The plugin is given the provider's own `document` + `awareness` (a
 * pre-instantiated provider is pushed as-is and otherwise would NOT share the
 * editor's doc), the provider instance, and the local user's `cursors.data`.
 * Remote carets render via {@link RemoteCursorOverlay}.
 *
 * Editors built from this kit MUST be created with `skipInitialization: true`
 * and driven through `editor.getApi(YjsPlugin).yjs.init(...)` / `.destroy()`.
 */
export function createCollabEditorKit(options: {
	cursor: CollabCursor;
	provider: UnifiedProvider;
}) {
	const { cursor, provider } = options;
	return [
		...EditorKit,
		YjsPlugin.configure({
			options: {
				awareness: provider.awareness,
				cursors: { data: cursor },
				providers: [provider],
				ydoc: provider.document,
			},
			render: {
				afterEditable: () => <RemoteCursorOverlay />,
			},
		}),
	];
}

export type CollabEditor = TPlateEditor<
	Value,
	ReturnType<typeof createCollabEditorKit>[number]
>;
