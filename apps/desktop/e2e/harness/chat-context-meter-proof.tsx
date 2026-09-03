import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const CONTEXT_SIZE = 1000;
const WARNING_USAGE = 730;
const CRITICAL_USAGE = 900;

function message(
	id: string,
	role: "assistant" | "user",
	text: string,
	parts?: UIMessage["parts"]
): UIMessage {
	return {
		id,
		parts: parts ?? [{ text, type: "text" }],
		role,
	} as unknown as UIMessage;
}

function chatMessages(id: string, used: number): UIMessage[] {
	return [
		message(`${id}-user`, "user", "Show me the current context usage."),
		message(
			`${id}-assistant`,
			"assistant",
			"Here is the current context usage.",
			[
				{ text: "Here is the current context usage.", type: "text" },
				{
					data: {
						completionTokens: 100,
						promptTokens: used - 100,
						tokensPerSecond: 42,
						totalTokens: used,
					},
					type: "data-ryu-stats",
				},
			]
		),
	];
}

function MeterCard({
	id,
	label,
	used,
}: {
	id: string;
	label: string;
	used: number;
}) {
	const [contextOpened, setContextOpened] = useState(false);

	return (
		<section
			className="flex min-w-0 flex-col gap-2"
			data-testid={`${id}-meter`}
		>
			<div className="flex items-baseline justify-between gap-3 px-1">
				<h2 className="font-medium text-sm">{label}</h2>
				<span className="text-muted-foreground text-xs">
					{used} / {CONTEXT_SIZE} tokens
				</span>
			</div>
			<div className="h-[460px] min-h-0 overflow-hidden rounded-3xl bg-background shadow-sm">
				<AgentChat
					assistantName="Ryu"
					contextSize={CONTEXT_SIZE}
					currentUser={{ id: "proof-user", name: "You" }}
					emptyStatePosition="center"
					messages={chatMessages(id, used)}
					onOpenContext={() => setContextOpened(true)}
					onSend={() => {
						// The proof only inspects the rendered context state.
					}}
					onStop={() => {
						// The proof only inspects the rendered context state.
					}}
					status="ready"
				/>
			</div>
			<div
				aria-live="polite"
				className="min-h-5 px-1 text-muted-foreground text-xs"
				data-testid={`${id}-context-opened`}
			>
				{contextOpened
					? "Context breakdown opened"
					: "Context breakdown closed"}
			</div>
		</section>
	);
}

function Story() {
	const [dark, setDark] = useState(false);

	useEffect(() => {
		document.documentElement.classList.toggle("dark", dark);
		document.documentElement.style.colorScheme = dark ? "dark" : "light";
	}, [dark]);

	return (
		<ChatDisplayPrefs>
			<div className="min-h-screen bg-muted p-5 text-foreground">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
					<div className="flex items-center justify-between gap-4">
						<div>
							<h1 className="font-heading font-semibold text-lg">
								Context meter semantic-token proof
							</h1>
							<p className="text-muted-foreground text-xs">
								The warning and critical states use the shared status tokens.
							</p>
						</div>
						<button
							className="rounded-full bg-background px-3 py-1.5 text-sm shadow-sm"
							data-testid="theme-toggle"
							onClick={() => setDark((value) => !value)}
							type="button"
						>
							{dark ? "Use light theme" : "Use dark theme"}
						</button>
					</div>
					<div className="grid min-w-0 gap-5 lg:grid-cols-2">
						<MeterCard
							id="warning"
							label="Warning state"
							used={WARNING_USAGE}
						/>
						<MeterCard
							id="critical"
							label="Critical state"
							used={CRITICAL_USAGE}
						/>
					</div>
				</div>
			</div>
		</ChatDisplayPrefs>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
