import {
	RyuAssistantChat,
	RyuAssistantMorph,
	type RyuAssistantRecentChat,
} from "@ryu/assistant-widget";
import { Logo } from "@ryu/ui/components/logo.tsx";
import type { UIMessage } from "ai";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

document.documentElement.classList.add("dark");

const RECENT_CHATS: RyuAssistantRecentChat[] = [
	{ id: "help", meta: "now", title: "Help request" },
	{ id: "filters", meta: "2d", title: "Provider and model filters" },
	{ id: "review", meta: "2d", title: "Code review" },
];

function Story() {
	const [open, setOpen] = useState(true);
	const [selectedChat, setSelectedChat] = useState<string | null>(null);
	const messages: UIMessage[] = [];

	return (
		<main className="flex min-h-svh items-center justify-center bg-background p-8 text-foreground">
			<div
				className="dark relative h-[620px] w-[400px]"
				data-testid="assistant-widget-proof"
			>
				<RyuAssistantMorph
					bgClassName="bg-gradient-to-b from-background/95 via-background/90 to-card/85 text-foreground"
					chromeClassName="ring-1 ring-white/10 shadow-2xl"
					contentHeight={620}
					contentWidth={400}
					isOpen={open}
					onOpenChange={setOpen}
					trigger={<Logo size="34px" variant="eyes" />}
					triggerLabel="Ask Ryu"
				>
					<RyuAssistantChat
						messages={messages}
						onClose={() => setOpen(false)}
						onSelectRecentChat={setSelectedChat}
						onSend={() => undefined}
						onStop={() => undefined}
						placement="floating"
						recentChats={RECENT_CHATS}
						status="ready"
						testId="assistant-widget-header"
						title="New chat"
					/>
				</RyuAssistantMorph>
			</div>
			<output className="sr-only" data-testid="selected-chat">
				{selectedChat ?? "none"}
			</output>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
