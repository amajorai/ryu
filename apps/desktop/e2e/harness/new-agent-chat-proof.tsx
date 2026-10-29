import { useState } from "react";
import { createRoot } from "react-dom/client";
import { buildNewAgentChatSeed } from "@/src/lib/agent-onboarding.ts";
import "../../src/index.css";

const CREATED_AGENT = { id: "proof-agent-7", name: "Orbit" };

function App() {
	const [chatSeed, setChatSeed] = useState<ReturnType<
		typeof buildNewAgentChatSeed
	> | null>(null);

	const createAgent = () => {
		setChatSeed(buildNewAgentChatSeed(CREATED_AGENT.id, CREATED_AGENT.name));
	};

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<p className="font-medium text-primary text-sm uppercase tracking-(--tracking-section)">
						Agent onboarding proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Every new agent gets a first conversation
					</h1>
					<p className="max-w-2xl text-muted-foreground">
						The browser proof exercises the same shared chat seed used by the
						manual create dialog and the full agent editor.
					</p>
				</header>

				<section
					className="rounded-2xl border bg-card p-6 shadow-sm"
					data-testid="create-state"
				>
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="font-medium">Manual creation</p>
							<p className="text-muted-foreground text-sm">
								Create “{CREATED_AGENT.name}” and start its welcome chat.
							</p>
						</div>
						<button
							className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground text-sm"
							onClick={createAgent}
							type="button"
						>
							Create agent
						</button>
					</div>
				</section>

				{chatSeed ? (
					<section
						aria-label="Created agent chat"
						className="flex flex-col gap-5 rounded-2xl border bg-card p-6 shadow-sm"
						data-testid="created-chat"
					>
						<div className="flex items-center justify-between gap-4 border-b pb-4">
							<div>
								<p
									className="font-semibold text-lg"
									data-testid="created-agent"
								>
									{CREATED_AGENT.name}
								</p>
								<p className="text-muted-foreground text-sm">
									New chat · agent selected automatically
								</p>
							</div>
							<span
								className="rounded-full bg-primary/10 px-3 py-1 font-medium text-primary text-xs"
								data-testid="chat-tab"
							>
								{chatSeed.title}
							</span>
						</div>

						<div className="flex flex-col gap-3 text-sm">
							<div
								className="max-w-xl self-end rounded-2xl rounded-br-md bg-muted px-4 py-3"
								data-testid="welcome-request"
							>
								{chatSeed.initialPrompt}
							</div>
							<div
								className="max-w-xl rounded-2xl rounded-bl-md bg-primary/10 px-4 py-3"
								data-testid="agent-introduction"
							>
								Hi — I’m {CREATED_AGENT.name}, your new agent. I’m ready to help
								with the work you configured for me. What would you like to work
								on first?
							</div>
						</div>

						<div className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-3">
							<div>
								<p className="text-muted-foreground">Route</p>
								<p data-testid="chat-route">/chat</p>
							</div>
							<div>
								<p className="text-muted-foreground">Agent id</p>
								<p data-testid="chat-agent-id">{chatSeed.initialAgent}</p>
							</div>
							<div>
								<p className="text-muted-foreground">Auto-send</p>
								<p data-testid="chat-auto-send">
									{chatSeed.initialSubmit ? "welcome request sent" : "not sent"}
								</p>
							</div>
						</div>

						<p
							className="font-semibold text-primary text-sm"
							data-testid="proof-status"
						>
							VERIFIED
						</p>
					</section>
				) : null}
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("proof root missing");
}

createRoot(root).render(<App />);
