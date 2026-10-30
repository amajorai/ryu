// Prompt Studio: the one-shot draft prompt preview panel.

import { useChat } from "@ai-sdk/react";
import { Square01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useRef } from "react";
import { cancelChat, chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { instrumentedFetch } from "@/src/lib/dev-metrics.ts";

interface PreviewPanelProps {
	agentId: string;
	convId: string;
	prompt: string;
	target: ApiTarget;
}

export function PreviewPanel({
	prompt,
	agentId,
	target,
	convId,
}: PreviewPanelProps) {
	// The preview sends the rendered draft prompt framed as a user message so the
	// agent can echo it back or reflect on it. This is the only approach available
	// without a system_prompt override field in ChatStreamRequest.
	const previewMessage = `[PROMPT PREVIEW]\n\nDraft system prompt:\n\`\`\`\n${prompt}\n\`\`\`\n\nRespond as if this were your system prompt and confirm you understand your role.`;

	const { messages, sendMessage, status, error, stop } = useChat({
		id: convId,
		transport: new DefaultChatTransport({
			api: chatStreamUrl(target),
			// Developer-mode turn timing; a plain `fetch` when metrics are off.
			fetch: instrumentedFetch,
			headers: (): Record<string, string> => chatHeaders(target),
			body: () => ({
				agent_id: agentId,
				response_mode: "developer",
				conversation_id: convId,
				enable_long_term: false,
			}),
		}),
	});
	const sentConversationRef = useRef<string | null>(null);
	useEffect(() => {
		if (sentConversationRef.current === convId) {
			return;
		}
		sentConversationRef.current = convId;
		// Opening Preview prompt is the user action that starts this ephemeral
		// conversation. Showing a fabricated user message alone left the panel
		// permanently at "No response yet" without sending anything to Core.
		void sendMessage({ text: previewMessage });
	}, [convId, previewMessage, sendMessage]);

	const isStreaming = status === "streaming" || status === "submitted";
	// Core keeps the saved preview turn running after its stream is aborted, so
	// Stop also cancels it there.
	const stopPreview = useCallback(() => {
		void stop();
		cancelChat(target, convId).catch(() => {
			// No live turn, or Core is unreachable; the abort above still stands.
		});
	}, [convId, stop, target]);

	const assistantMessages = messages.filter((m) => m.role === "assistant");
	const lastAssistant = assistantMessages.at(-1);

	const responseText =
		lastAssistant?.parts
			.filter((p) => p.type === "text")
			.map((part) => part.text)
			.join("") ?? "";

	return (
		<div className="flex flex-col gap-3 rounded-lg bg-card p-4">
			<div className="flex items-center gap-2">
				<span className="font-medium text-sm">Preview response</span>
				{isStreaming ? (
					<Badge className="ml-auto" motion="pulse" variant="secondary">
						Streaming…
					</Badge>
				) : null}
				{isStreaming ? (
					<Button
						aria-label="Stop preview response"
						onClick={stopPreview}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3" icon={Square01Icon} />
					</Button>
				) : null}
			</div>

			{error ? (
				<p className="text-status-destructive text-xs">{error.message}</p>
			) : null}

			{responseText ? (
				<div className="whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs leading-relaxed">
					{responseText}
				</div>
			) : (
				<PreviewPlaceholder streaming={isStreaming} />
			)}
		</div>
	);
}

function PreviewPlaceholder({ streaming }: { streaming: boolean }) {
	if (streaming) {
		return (
			<p className="text-muted-foreground text-xs">Waiting for response…</p>
		);
	}
	return <p className="text-muted-foreground text-xs">No response yet.</p>;
}
