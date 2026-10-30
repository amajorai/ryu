import type React from "react";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import type { MessageGroupPosition } from "./message-bubble.ts";
import type {
	MessageListProps,
	ToolRendererProps,
} from "./message-list-types.ts";
import type {
	AgentMessageContext,
	CustomToolRendererProps,
	MentionItem,
} from "./types.ts";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";

export interface AssistantPartsProps {
	agentMessageContext?: AgentMessageContext;
	deferTurnEndCards: boolean;
	groupPosition: MessageGroupPosition;
	isLast: boolean;
	isStreaming: boolean;
	mentionItems?: MentionItem[];
	msg: RenderedMessage;
	onAgentUiSubmit?: MessageListProps["onAgentUiSubmit"];
	onAnnotateImage?: MessageListProps["onAnnotateImage"];
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	onRetryError?: () => void;
	onRetryGeneration?: MessageListProps["onRetryGeneration"];
	onWorkflowResume?: MessageListProps["onWorkflowResume"];
	previewResolvers?: LinkPreviewResolvers;
	suppressQuestionTool: boolean;
	ToolRendererComponent: React.ComponentType<ToolRendererProps>;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
}
