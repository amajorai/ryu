import { Button } from "@ryu/ui/components/button.tsx";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import {
	type ConversationModelChange,
	type ConversationModelSelectionState,
	getConversationModelSelection,
	recordConversationModelSelection,
} from "../../src/lib/api/conversation-model-selection.ts";
import "../../src/index.css";

const CONVERSATION_ID = "model-selection-proof-room";

const MESSAGES = [
	{
		id: "model-proof-user",
		parts: [
			{ text: "Compare these two implementation approaches.", type: "text" },
		],
		role: "user",
	},
	{
		id: "model-proof-assistant",
		parts: [
			{
				text: "I’ll compare the trade-offs and make a recommendation.",
				type: "text",
			},
		],
		role: "assistant",
	},
] satisfies UIMessage[];

function mergeChanges(
	current: ConversationModelChange[],
	incoming: ConversationModelChange
): ConversationModelChange[] {
	const byId = new Map(current.map((change) => [change.id, change]));
	byId.set(incoming.id, incoming);
	return [...byId.values()].sort(
		(left, right) => left.sequence - right.sequence
	);
}

function noticesFor(changes: ConversationModelChange[]) {
	return changes.map((change) => {
		const provider = change.providerLabel ?? change.providerId;
		const model = change.modelLabel ?? change.modelId;
		return {
			description:
				provider && model
					? `${provider} · ${model}`
					: provider
						? `${provider} · Provider default`
						: (model ?? "Automatic model selection"),
			id: `model-change-${change.id}`,
			title:
				change.kind === "initial"
					? "Model used for this conversation"
					: provider
						? "Provider and model changed"
						: "Model changed",
		};
	});
}

function SharedConversationView({ participant }: { participant: string }) {
	const target = useMemo<ApiTarget>(
		() => ({
			token: "proof-node-token",
			url: window.location.origin,
			userJwt: `proof-${participant.toLowerCase()}-jwt`,
		}),
		[participant]
	);
	const [selection, setSelection] = useState<ConversationModelSelectionState>({
		changes: [],
		current: null,
		handoffs: [],
	});
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getConversationModelSelection(target, CONVERSATION_ID)
			.then((next) => {
				if (!cancelled) {
					setSelection(next);
				}
			})
			.catch((cause) => {
				if (!cancelled) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load this conversation."
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const currentLabel = selection.current
		? `${selection.current.providerLabel ?? selection.current.providerId ?? "Automatic"} · ${selection.current.modelLabel ?? selection.current.modelId ?? "Default model"}`
		: "No model has been recorded yet";

	const changeSelection = async () => {
		setSaving(true);
		setError(null);
		try {
			const result = await recordConversationModelSelection(
				target,
				CONVERSATION_ID,
				{
					changeId: crypto.randomUUID(),
					kind: "change",
					modelId: "openai/gpt-5-mini",
					modelLabel: "openai/gpt-5-mini",
					providerId: "openrouter",
					providerLabel: "OpenRouter",
				}
			);
			if (result.changed) {
				setSelection((current) => ({
					changes: mergeChanges(current.changes, result.change),
					current: result.change,
					handoffs: current.handoffs,
				}));
			}
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save this selection."
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<main className="flex min-h-screen flex-col bg-background p-6 text-foreground">
			<header className="mx-auto mb-5 w-full max-w-4xl">
				<p className="text-muted-foreground text-sm">Shared conversation</p>
				<h1 className="font-semibold text-2xl tracking-tight">
					{participant} view
				</h1>
				<p
					className="mt-1 text-muted-foreground text-sm"
					data-testid="current-selection"
				>
					Current model: {loading ? "Loading…" : currentLabel}
				</p>
				{participant === "Owner" ? (
					<Button disabled={loading || saving} onClick={changeSelection}>
						Switch provider and model
					</Button>
				) : null}
				{error ? (
					<p className="mt-2 text-destructive text-sm" role="alert">
						{error}
					</p>
				) : null}
			</header>
			<section
				aria-label={`${participant} conversation history`}
				className="mx-auto h-[720px] w-full max-w-4xl overflow-hidden rounded-2xl border border-border/70 bg-card/40 shadow-sm"
			>
				<ChatDisplayPrefs>
					<AgentChat
						assistantName="Ryu"
						currentUser={{ id: participant.toLowerCase(), name: participant }}
						historyNotices={noticesFor(selection.changes)}
						messages={MESSAGES}
						onSend={() => undefined}
						onStop={() => undefined}
						status="ready"
					/>
				</ChatDisplayPrefs>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	const participant =
		new URLSearchParams(window.location.search).get("participant") ?? "Owner";
	createRoot(root).render(<SharedConversationView participant={participant} />);
}
