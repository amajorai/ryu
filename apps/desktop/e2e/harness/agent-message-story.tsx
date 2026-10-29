import { AgentMessageTool } from "@ryu/blocks/desktop/agent-elements/tools/agent-message-tool.tsx";
import { AgentMessagesMarker } from "@ryu/blocks/desktop/agent-elements/tools/agent-messages-marker.tsx";
import type { AgentMessageContext } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const messagePart = {
	input: {
		text: "I found the retry path. Can you review the patch before I merge it?",
		to: "reviewer",
	},
	output: {
		text: JSON.stringify({
			from: "builder",
			ok: true,
			to: "reviewer",
		}),
		type: "text",
	},
	state: "output-available",
	type: "tool-mcp-agent-comms.agents.send",
};

const fanOutPeers = [
	["engineering", "Ryu Engineering"],
	["go-to-market", "Ryu Go-to-Market"],
	["admin", "Ryu Admin"],
	["job-applications", "Job Applications"],
	["inbox-monitor", "Inbox Monitor"],
	["tracker", "Ryu Tracker"],
	["news-digest", "News Digest"],
] as const;

const fanOutParts = fanOutPeers.map(([id], index) => ({
	input: {
		text:
			id === "engineering"
				? "FYI: Jia Wei claimed jiaweing@mail.example.com. Your tagged address is jiaweing+eng@mail.example.com (mail to it lands in the shared inbox)."
				: `FYI: your tagged address is jiaweing+${id}@mail.example.com.`,
		to: id,
	},
	output: { from: "builder", ok: id !== "news-digest", to: id },
	state: "output-available",
	toolCallId: `fan-out-${index}`,
	type: "tool-mcp-agent-comms.agents.send",
}));

const fanOutNames = new Map<string, string>(fanOutPeers);

const identityContext: AgentMessageContext = {
	current: {
		avatar: (
			<DitherAvatar animate={false} className="size-full" name="builder" />
		),
		id: "builder",
		name: "Build Agent",
	},
	resolve: (id) =>
		fanOutNames.has(id)
			? {
					avatar: (
						<DitherAvatar animate={false} className="size-full" name={id} />
					),
					id,
					name: fanOutNames.get(id) ?? id,
				}
			: id === "reviewer"
				? {
						avatar: (
							<DitherAvatar
								animate={false}
								className="size-full"
								name="reviewer"
							/>
						),
						id,
						name: "Review Agent",
					}
				: undefined,
};

function Story() {
	return (
		<main className="min-h-screen bg-background px-8 py-12 text-foreground">
			<div className="mx-auto max-w-2xl space-y-6">
				<header className="space-y-1">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
						Agent communication
					</p>
					<h1 className="font-semibold text-2xl tracking-tight">
						Message activity in the transcript
					</h1>
					<p className="text-muted-foreground text-sm">
						The sender identity appears in the activity marker and the message
						bubble.
					</p>
				</header>

				<section
					aria-label="Agent message transcript"
					className="rounded-2xl border bg-card p-6 shadow-sm"
				>
					<AgentMessageTool
						chatStatus="ready"
						context={identityContext}
						part={messagePart}
					/>
				</section>

				<section
					aria-label="Agent fan-out transcript"
					className="rounded-2xl border bg-card p-6 shadow-sm"
				>
					<AgentMessagesMarker
						context={identityContext}
						parts={fanOutParts}
						sentAt={new Date()}
					/>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
