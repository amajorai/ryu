import { useChat } from "@ai-sdk/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { ThemeProvider } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudEnvironmentPicker } from "../../src/components/chat/CloudEnvironmentPicker.tsx";
import { CloudEnvironmentsSettings } from "../../src/components/gateway/CloudEnvironmentsSettings.tsx";
import { useCloudTaskSelection } from "../../src/hooks/useCloudTaskSelection.ts";
import {
	cloudTaskBlockReason,
	cloudTaskRequestFields,
	useCloudTaskSelections,
} from "../../src/lib/cloud-task-selection.ts";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "cloud-environments-product.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const target = {
	url:
		new URLSearchParams(window.location.search).get("core") ??
		window.location.origin,
	token: new URLSearchParams(window.location.search).has("core")
		? "proof-node-token"
		: "cloud-proof-node-token",
	userJwt: "cloud-proof-user-identity",
};

const root = document.getElementById("root");
if (!root) {
	throw new Error("Cloud environment proof root is missing");
}

function Proof() {
	const [activeTarget, setActiveTarget] = useState(target);
	useEffect(() => {
		const switchTarget = () =>
			setActiveTarget({
				...target,
				url: `${window.location.origin}/alternate`,
			});
		window.addEventListener("cloud-proof-switch-target", switchTarget);
		return () =>
			window.removeEventListener("cloud-proof-switch-target", switchTarget);
	}, []);
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<main className="min-h-screen bg-background px-4 py-8 font-sans text-foreground sm:px-8">
					<div className="mx-auto max-w-5xl">
						{new URLSearchParams(window.location.search).has("task") ? (
							<CloudTaskComposer target={activeTarget} />
						) : (
							<CloudEnvironmentsSettings target={activeTarget} />
						)}
					</div>
				</main>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

function CloudTaskComposer({ target: taskTarget }: { target: typeof target }) {
	const [conversationId] = useState(
		() =>
			new URLSearchParams(window.location.search).get("conversation") ??
			crypto.randomUUID()
	);
	const existing = new URLSearchParams(window.location.search).has(
		"conversation"
	);
	const { scope, selection, retry } = useCloudTaskSelection(
		taskTarget,
		conversationId,
		existing
	);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const [agentId, setAgentId] = useState("ryu");
	const agentRef = useRef(agentId);
	agentRef.current = agentId;
	const [prompt, setPrompt] = useState("");
	const { sendMessage, messages, status, error } = useChat({
		id: conversationId,
		transport: new DefaultChatTransport({
			api: `${taskTarget.url}/api/chat/stream`,
			body: () => ({
				conversation_id: conversationId,
				agent_id: agentRef.current,
				...cloudTaskRequestFields(selectionRef.current, agentRef.current),
			}),
		}),
	});
	const reason = cloudTaskBlockReason(selection, agentId);
	return (
		<div className="space-y-4">
			<h1 className="font-semibold text-xl">New Code task</h1>
			<CloudEnvironmentPicker
				key={scope ?? "loading"}
				onRetry={retry}
				scope={scope}
				selection={selection}
				target={taskTarget}
			/>
			<NativeSelect
				aria-label="Task agent"
				onChange={(event) => setAgentId(event.target.value)}
				value={agentId}
			>
				<NativeSelectOption value="ryu">Ryu</NativeSelectOption>
				<NativeSelectOption value="custom-acp">
					Custom ACP agent
				</NativeSelectOption>
			</NativeSelect>
			<Textarea
				aria-label="Task message"
				onChange={(event) => setPrompt(event.target.value)}
				placeholder="Describe your task"
				value={prompt}
			/>
			{reason ? (
				<p className="text-muted-foreground text-sm" role="status">
					{reason}
				</p>
			) : null}
			{error ? <p role="alert">{error.message}</p> : null}
			<Button
				disabled={
					Boolean(reason) ||
					!prompt.trim() ||
					status === "submitted" ||
					status === "streaming"
				}
				onClick={() => {
					if (scope && "locked" in selection) {
						useCloudTaskSelections
							.getState()
							.setSelection(scope, { ...selection, locked: true });
					}
					sendMessage({ text: prompt });
					setPrompt("");
				}}
			>
				Send task
			</Button>
			{messages.map((message) => (
				<div className="rounded-lg bg-muted p-3 text-sm" key={message.id}>
					{message.parts.map((part, index) =>
						part.type === "text" ? (
							<p key={`${message.id}-${index}`}>{part.text}</p>
						) : null
					)}
				</div>
			))}
		</div>
	);
}

createRoot(root).render(<Proof />);
