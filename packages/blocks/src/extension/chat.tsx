"use client";

import type { ReactNode } from "react";

export interface ExtensionChatProps {
	/** Agent selector row. */
	agentSelector?: ReactNode;
	/** Conversation list rail (the live page renders its ChatSidebar). */
	sidebar?: ReactNode;
	/** The thread / message region (the live page renders the assistant-ui Thread). */
	thread?: ReactNode;
}

/**
 * The real extension dashboard chat layout, presentational. The live page
 * (apps/extension/pages/ChatPage.tsx) owns the assistant-ui runtime, the node
 * store, and conversation history; it injects its ChatSidebar, AgentSelector,
 * and Thread into the slots. The storyboard fills the slots with static markup.
 */
export default function ExtensionChat({
	sidebar,
	agentSelector,
	thread,
}: ExtensionChatProps) {
	return (
		<div className="flex h-full overflow-hidden">
			<div className="w-56 shrink-0 border-r">{sidebar}</div>

			<div className="flex flex-1 flex-col overflow-hidden">
				<div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
					{agentSelector}
				</div>

				<div className="relative flex-1 overflow-hidden">{thread}</div>
			</div>
		</div>
	);
}
