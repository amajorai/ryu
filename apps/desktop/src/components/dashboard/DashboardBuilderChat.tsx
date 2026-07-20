// The "build with AI" pane of the Home page. A chat that authors and arranges
// THIS dashboard's widgets: the user says "show me my unread email and a chart of
// signups" and the model assembles the grid by calling Core's
// `dashboard_builder__*` tools. After each settled turn we refetch the dashboard
// so the grid re-materialises. Mirrors WorkflowBuilderChat exactly.

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgentChat } from "@/components/agent-elements/agent-chat.tsx";
import { useComposerSlot } from "@/src/components/assistant/useComposerSlot.tsx";
import { useBuilderRuntime } from "@/src/hooks/useBuilderRuntime.ts";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { WIDGET_DEFINITIONS } from "./widgets/registry.tsx";

/** localStorage key for this builder's driving-agent pick (defaults to `ryu`,
 *  which reliably runs the `dashboard_builder__*` tool loop). Remembered apart
 *  from the other builders' picks. */
const DASHBOARD_BUILDER_AGENT_KEY = "ryu_dashboard_builder_agent";

/** The widget kinds the client can render, straight from the catalog. */
const WIDGET_KINDS = WIDGET_DEFINITIONS.map((d) => d.kind).join(", ");

interface DashboardBuilderChatProps {
	/**
	 * A one-shot prompt to send automatically when the pane opens (the "Generate a
	 * dashboard for me" path). Sent once, then reported via `onAutoPromptConsumed`.
	 */
	autoPrompt?: string | null;
	dashboardId: string | null;
	dashboardName: string;
	/** Compact snapshot of the current widgets, injected into the preamble. */
	dashboardSnapshot: string;
	/** Called after the auto-prompt has been sent so the parent can clear it. */
	onAutoPromptConsumed?: () => void;
	/** Called after each settled turn with the edited id so the grid re-hydrates. */
	onDashboardChanged: (id: string) => void;
	/** Lazily resolve (creating one if needed) the id to edit. Null on failure. */
	resolveDashboardId: () => Promise<string | null>;
	target: ApiTarget;
}

function buildPreamble(dashboardId: string, snapshot: string): string {
	return [
		"You are Ryu's Home dashboard builder. You are helping the user assemble the",
		`dashboard with id "${dashboardId}". A dashboard is a grid of widgets, each with`,
		`a kind (${WIDGET_KINDS}), a data source, and a grid layout. When the user describes`,
		"what they want to see, BUILD it by calling the dashboard_builder tools. For edits",
		`prefer dashboard_builder__configure_dashboard with dashboard_id "${dashboardId}"`,
		"using widgets_upsert (pass each widget's layout x/y/w/h to place it on the",
		"12-column grid) and widgets_remove. Call dashboard_builder__get_dashboard first",
		"if you need the current widgets. Pick a sensible source: core_endpoint for",
		"internal metrics (connections, quests, monitors, system_status, …), monitor,",
		"workflow, composio, http, or agent. If a save is rejected, read the error and",
		"fix it. Keep replies short and confirm what you changed.",
		`\n\nCurrent dashboard:\n${snapshot}`,
	].join(" ");
}

/** Prepend the preamble to the first user message's first text part (outgoing only). */
function injectPreamble(messages: UIMessage[], preamble: string): UIMessage[] {
	let injected = false;
	return messages.map((message) => {
		if (injected || message.role !== "user") {
			return message;
		}
		injected = true;
		let textDone = false;
		const parts = message.parts.map((part) => {
			if (!textDone && part.type === "text") {
				textDone = true;
				return { ...part, text: `${preamble}\n\nUser: ${part.text}` };
			}
			return part;
		});
		return { ...message, parts };
	});
}

export function DashboardBuilderChat({
	autoPrompt,
	target,
	dashboardId,
	dashboardName,
	dashboardSnapshot,
	resolveDashboardId,
	onAutoPromptConsumed,
	onDashboardChanged,
}: DashboardBuilderChatProps) {
	const dashboardIdRef = useRef<string | null>(dashboardId);
	const snapshotRef = useRef(dashboardSnapshot);
	useEffect(() => {
		dashboardIdRef.current = dashboardId;
	}, [dashboardId]);
	useEffect(() => {
		snapshotRef.current = dashboardSnapshot;
	}, [dashboardSnapshot]);

	const conversationId = useMemo(
		() => `dash-builder-${crypto.randomUUID()}`,
		[]
	);

	// The driving agent + model — switchable in the composer, exactly like the
	// agent/workflow builders. Defaults to `ryu` so the tool loop that applies the
	// dashboard edits runs out of the box. `bodyFields()` reads the live pick.
	const runtime = useBuilderRuntime(DASHBOARD_BUILDER_AGENT_KEY);
	const bodyFieldsRef = useRef(runtime.bodyFields);
	bodyFieldsRef.current = runtime.bodyFields;

	const transport = useMemo(
		() =>
			new DefaultChatTransport<UIMessage>({
				api: chatStreamUrl(target),
				headers: () => chatHeaders(target),
				prepareSendMessagesRequest: ({ messages }) => {
					const id = dashboardIdRef.current;
					const outgoing = id
						? injectPreamble(messages, buildPreamble(id, snapshotRef.current))
						: messages;
					return {
						body: {
							messages: outgoing,
							...bodyFieldsRef.current(),
							conversation_id: conversationId,
							persist: false,
							enable_long_term: false,
						},
					};
				},
			}),
		[target, conversationId]
	);

	const { messages, sendMessage, stop, status, error } = useChat({
		id: conversationId,
		transport,
	});

	// The full chat composer (Agent · Model · Thinking + voice + voice mode + image
	// attachments + compact-once-history), the SAME one the chat page renders, via
	// the shared slot — no more bare textarea here.
	const composer = useComposerSlot(runtime, {
		target,
		compact: messages.length > 0,
		conversationId,
	});
	const takeImagesRef = useRef(composer.takeImages);
	takeImagesRef.current = composer.takeImages;

	const prevStatusRef = useRef(status);
	useEffect(() => {
		const was = prevStatusRef.current;
		prevStatusRef.current = status;
		if (status === "ready" && (was === "streaming" || was === "submitted")) {
			const id = dashboardIdRef.current;
			if (id) {
				onDashboardChanged(id);
			}
		}
	}, [status, onDashboardChanged]);

	const handleSend = useCallback(
		async (message: { role: "user"; content: string }) => {
			const id = await resolveDashboardId();
			if (!id) {
				return;
			}
			dashboardIdRef.current = id;
			const files = takeImagesRef.current();
			sendMessage(
				files ? { text: message.content, files } : { text: message.content }
			);
		},
		[resolveDashboardId, sendMessage]
	);

	// Fire the auto-prompt (the "Generate for me" path) when the chat is idle. The
	// guard is re-armed whenever the prompt clears, so a later Generate click on the
	// still-mounted pane sends again, while a plain re-render never double-sends.
	const autoSentRef = useRef(false);
	useEffect(() => {
		if (!autoPrompt) {
			autoSentRef.current = false;
			return;
		}
		if (autoSentRef.current || status !== "ready") {
			return;
		}
		autoSentRef.current = true;
		handleSend({ role: "user", content: autoPrompt }).catch(() => {
			// resolveDashboardId already surfaces its own failure.
		});
		onAutoPromptConsumed?.();
	}, [autoPrompt, status, handleSend, onAutoPromptConsumed]);

	return (
		<>
			<AgentChat
				attachments={composer.attachments}
				emptyStateHeader={
					<div className="flex flex-col gap-1 px-1 pb-3 text-center">
						<span className="font-semibold text-base">
							Build {dashboardName.trim() || "this dashboard"}
						</span>
						<span className="text-muted-foreground text-sm">
							Describe what you want to see. I'll add widgets and arrange them
							on the grid, each pulling live data.
						</span>
					</div>
				}
				emptyStatePosition="center"
				error={error ?? undefined}
				messages={messages}
				onSend={(m) => {
					handleSend(m).catch(() => {
						// resolveDashboardId already surfaces its own failure.
					});
				}}
				onStop={stop}
				slots={{ InputBar: composer.inputBar }}
				status={status}
			/>
			{/* ChatGPT-style voice mode overlay (full-screen). */}
			{composer.voiceModeOverlay}
		</>
	);
}
