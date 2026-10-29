"use client";

import {
	NestedOverflowToolbar,
	type NestedOverflowToolbarProps,
} from "@ryu/ui/components/nested-overflow-toolbar.tsx";
import {
	ArrowUpToLineIcon,
	BaselineIcon,
	BlocksIcon,
	BoldIcon,
	Code2Icon,
	FileTextIcon,
	HighlighterIcon,
	ImageIcon,
	ItalicIcon,
	ListTreeIcon,
	MessageSquareIcon,
	PaintBucketIcon,
	Settings2Icon,
	StrikethroughIcon,
	TypeIcon,
	UnderlineIcon,
	WandSparklesIcon,
} from "lucide-react";
import { KEYS } from "platejs";
import { useEditorReadOnly } from "platejs/react";

import { AIToolbarButton } from "./ai-toolbar-button.tsx";
import { AlignToolbarButton } from "./align-toolbar-button.tsx";
import { CommentToolbarButton } from "./comment-toolbar-button.tsx";
import { EmojiToolbarButton } from "./emoji-toolbar-button.tsx";
import { ExportToolbarButton } from "./export-toolbar-button.tsx";
import { FontColorToolbarButton } from "./font-color-toolbar-button.tsx";
import { FontSizeToolbarButton } from "./font-size-toolbar-button.tsx";
import {
	RedoToolbarButton,
	UndoToolbarButton,
} from "./history-toolbar-button.tsx";
import { ImportToolbarButton } from "./import-toolbar-button.tsx";
import {
	IndentToolbarButton,
	OutdentToolbarButton,
} from "./indent-toolbar-button.tsx";
import { InsertToolbarButton } from "./insert-toolbar-button.tsx";
import { LineHeightToolbarButton } from "./line-height-toolbar-button.tsx";
import { LinkToolbarButton } from "./link-toolbar-button.tsx";
import {
	BulletedListToolbarButton,
	NumberedListToolbarButton,
	TodoListToolbarButton,
} from "./list-toolbar-button.tsx";
import { MarkToolbarButton } from "./mark-toolbar-button.tsx";
import { MediaToolbarButton } from "./media-toolbar-button.tsx";
import { ModeToolbarButton } from "./mode-toolbar-button.tsx";
import { MoreToolbarButton } from "./more-toolbar-button.tsx";
import { TableToolbarButton } from "./table-toolbar-button.tsx";
import { ToggleToolbarButton } from "./toggle-toolbar-button.tsx";
import { ToolbarGroup } from "./toolbar.tsx";
import { TurnIntoToolbarButton } from "./turn-into-toolbar-button.tsx";

export function FixedToolbarButtons({
	expandedLayout = "nested",
	placement = "fixed",
}: Pick<NestedOverflowToolbarProps, "expandedLayout" | "placement"> = {}) {
	const readOnly = useEditorReadOnly();
	const wrapCategoryTools = expandedLayout === "grid";

	const reviewControls = (
		<ToolbarGroup wrap={wrapCategoryTools}>
			<MarkToolbarButton nodeType={KEYS.highlight} tooltip="Highlight">
				<HighlighterIcon />
			</MarkToolbarButton>
			<CommentToolbarButton />
			<ModeToolbarButton />
		</ToolbarGroup>
	);

	return (
		<NestedOverflowToolbar
			ariaLabel="Page editor tools"
			categories={
				readOnly
					? [
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										<MarkToolbarButton
											nodeType={KEYS.highlight}
											tooltip="Highlight"
										>
											<HighlighterIcon />
										</MarkToolbarButton>
										<CommentToolbarButton />
									</ToolbarGroup>
								),
								icon: <MessageSquareIcon />,
								id: "review",
								label: "Review",
							},
						]
					: [
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										<ExportToolbarButton>
											<ArrowUpToLineIcon />
										</ExportToolbarButton>
										<ImportToolbarButton />
									</ToolbarGroup>
								),
								icon: <FileTextIcon />,
								id: "file",
								label: "File",
							},
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										<InsertToolbarButton />
										<TurnIntoToolbarButton />
										<FontSizeToolbarButton />
									</ToolbarGroup>
								),
								icon: <BlocksIcon />,
								id: "insert",
								label: "Insert",
							},
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										{expandedLayout !== "grid" && (
											<MarkToolbarButton
												aria-label="Bold (⌘+B)"
												nodeType={KEYS.bold}
												tooltip="Bold (⌘+B)"
											>
												<BoldIcon />
											</MarkToolbarButton>
										)}
										{expandedLayout !== "grid" && (
											<MarkToolbarButton
												aria-label="Italic (⌘+I)"
												nodeType={KEYS.italic}
												tooltip="Italic (⌘+I)"
											>
												<ItalicIcon />
											</MarkToolbarButton>
										)}
										<MarkToolbarButton
											aria-label="Underline (⌘+U)"
											nodeType={KEYS.underline}
											tooltip="Underline (⌘+U)"
										>
											<UnderlineIcon />
										</MarkToolbarButton>
										<MarkToolbarButton
											aria-label="Strikethrough (⌘+⇧+M)"
											nodeType={KEYS.strikethrough}
											tooltip="Strikethrough (⌘+⇧+M)"
										>
											<StrikethroughIcon />
										</MarkToolbarButton>
										<MarkToolbarButton
											aria-label="Code (⌘+E)"
											nodeType={KEYS.code}
											tooltip="Code (⌘+E)"
										>
											<Code2Icon />
										</MarkToolbarButton>
										<FontColorToolbarButton
											nodeType={KEYS.color}
											tooltip="Text color"
										>
											<BaselineIcon />
										</FontColorToolbarButton>
										<FontColorToolbarButton
											nodeType={KEYS.backgroundColor}
											tooltip="Background color"
										>
											<PaintBucketIcon />
										</FontColorToolbarButton>
									</ToolbarGroup>
								),
								icon: <TypeIcon />,
								id: "format",
								label: "Format",
							},
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										<AlignToolbarButton />
										<NumberedListToolbarButton />
										<BulletedListToolbarButton />
										<TodoListToolbarButton />
										<ToggleToolbarButton />
										<LineHeightToolbarButton />
										<OutdentToolbarButton />
										<IndentToolbarButton />
									</ToolbarGroup>
								),
								icon: <ListTreeIcon />,
								id: "blocks",
								label: "Blocks",
							},
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										<LinkToolbarButton />
										<TableToolbarButton />
										<EmojiToolbarButton />
										<MediaToolbarButton nodeType={KEYS.img} />
										<MediaToolbarButton nodeType={KEYS.video} />
										<MediaToolbarButton nodeType={KEYS.audio} />
										<MediaToolbarButton nodeType={KEYS.file} />
									</ToolbarGroup>
								),
								icon: <ImageIcon />,
								id: "media",
								label: "Media",
							},
							{
								content: reviewControls,
								icon: <MessageSquareIcon />,
								id: "review",
								label: "Review",
							},
							{
								content: (
									<ToolbarGroup wrap={wrapCategoryTools}>
										<MoreToolbarButton />
									</ToolbarGroup>
								),
								icon: <Settings2Icon />,
								id: "advanced",
								label: "Advanced",
							},
						]
			}
			expandedLayout={expandedLayout}
			placement={placement}
			primary={
				readOnly ? (
					<ToolbarGroup>
						<ModeToolbarButton />
					</ToolbarGroup>
				) : (
					<>
						<ToolbarGroup>
							<UndoToolbarButton />
							<RedoToolbarButton />
						</ToolbarGroup>
						{expandedLayout === "grid" ? (
							<ToolbarGroup>
								<MarkToolbarButton nodeType={KEYS.bold} tooltip="Bold">
									<BoldIcon />
								</MarkToolbarButton>
								<MarkToolbarButton nodeType={KEYS.italic} tooltip="Italic">
									<ItalicIcon />
								</MarkToolbarButton>
							</ToolbarGroup>
						) : null}
						<ToolbarGroup>
							<AIToolbarButton tooltip="AI commands">
								<WandSparklesIcon />
							</AIToolbarButton>
						</ToolbarGroup>
					</>
				)
			}
		/>
	);
}
