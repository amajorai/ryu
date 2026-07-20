"use client";

import {
	BoldIcon,
	Code2Icon,
	ItalicIcon,
	StrikethroughIcon,
	UnderlineIcon,
	WandSparklesIcon,
} from "lucide-react";
import { KEYS } from "platejs";
import { useEditorReadOnly } from "platejs/react";

import { AIToolbarButton } from "./ai-toolbar-button.tsx";
import { CommentToolbarButton } from "./comment-toolbar-button.tsx";
import { InlineEquationToolbarButton } from "./equation-toolbar-button.tsx";
import { LinkToolbarButton } from "./link-toolbar-button.tsx";
import { MarkToolbarButton } from "./mark-toolbar-button.tsx";
import { MoreToolbarButton } from "./more-toolbar-button.tsx";
import { SuggestionToolbarButton } from "./suggestion-toolbar-button.tsx";
import { ToolbarGroup } from "./toolbar.tsx";
import { TurnIntoToolbarButton } from "./turn-into-toolbar-button.tsx";

export function FloatingToolbarButtons() {
	const readOnly = useEditorReadOnly();

	return (
		<>
			{!readOnly && (
				<>
					<ToolbarGroup>
						<AIToolbarButton tooltip="AI commands">
							<WandSparklesIcon />
							Ask AI
						</AIToolbarButton>
					</ToolbarGroup>

					<ToolbarGroup>
						<TurnIntoToolbarButton />

						<MarkToolbarButton nodeType={KEYS.bold} tooltip="Bold (⌘+B)">
							<BoldIcon />
						</MarkToolbarButton>

						<MarkToolbarButton nodeType={KEYS.italic} tooltip="Italic (⌘+I)">
							<ItalicIcon />
						</MarkToolbarButton>

						<MarkToolbarButton
							nodeType={KEYS.underline}
							tooltip="Underline (⌘+U)"
						>
							<UnderlineIcon />
						</MarkToolbarButton>

						<MarkToolbarButton
							nodeType={KEYS.strikethrough}
							tooltip="Strikethrough (⌘+⇧+M)"
						>
							<StrikethroughIcon />
						</MarkToolbarButton>

						<MarkToolbarButton nodeType={KEYS.code} tooltip="Code (⌘+E)">
							<Code2Icon />
						</MarkToolbarButton>

						<InlineEquationToolbarButton />

						<LinkToolbarButton />
					</ToolbarGroup>
				</>
			)}

			<ToolbarGroup>
				<CommentToolbarButton />
				<SuggestionToolbarButton />

				{!readOnly && <MoreToolbarButton />}
			</ToolbarGroup>
		</>
	);
}
