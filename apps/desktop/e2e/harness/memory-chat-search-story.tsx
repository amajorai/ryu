import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryChatSearch } from "../../src/components/memory/MemoryChatSearch.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import "../../src/index.css";

const target: ApiTarget = { token: null, url: window.location.origin };

const CONVERSATION_TITLES = new Map<string, string>([
	["conversation-architecture", "Architecture chat"],
	["conversation-launch", "Launch planning chat"],
]);

function Story() {
	const [openedConversation, setOpenedConversation] = useState("");
	const [openedView, setOpenedView] = useState("");

	return (
		<div className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-3xl">
				<MemoryChatSearch
					conversationTitle={(id) =>
						CONVERSATION_TITLES.get(id) ?? "Conversation"
					}
					onOpenConversation={setOpenedConversation}
					onOpenDream={() => setOpenedView("dream")}
					target={target}
				/>
				<div className="mt-4 rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
					Opened conversation: {openedConversation || "none"}
				</div>
				<div className="mt-2 rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
					Opened memory view: {openedView || "none"}
				</div>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
