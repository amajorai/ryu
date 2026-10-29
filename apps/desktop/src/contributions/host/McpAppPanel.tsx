import { useModelContextStore } from "@ryu/app-host/model-context";
import type { OpenedFileAccess } from "@ryu/app-host/opened-file";
import { AppWidget } from "@ryu/blocks/desktop/agent-elements/app-widget.tsx";
import {
	WidgetHostContext,
	type WidgetHostValue,
} from "@ryu/blocks/desktop/agent-elements/widget-host-context.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useQuery } from "@tanstack/react-query";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { McpForms, useMcpFormsOwned } from "@/src/components/chat/McpForms.tsx";
import { DockPageBoundary } from "@/src/components/panels/WorkspacePanels.tsx";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { sendChatBroadcastTurn } from "@/src/lib/api/chat-broadcast.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { type McpAppPart, openMcpApp } from "@/src/lib/api/mcp-apps.ts";
import type { PluginCompanion } from "@/src/lib/api/plugins.ts";
import {
	widgetCallTool,
	widgetFollowUp,
	widgetSetState,
} from "@/src/lib/api/widgets.ts";

const ChatPage = lazy(() => import("@/src/pages/ChatPage.tsx"));

export function McpAppPanel({
	companion,
	conversationId,
	fileAccess,
	appPath,
	globalEntry = false,
}: {
	companion: PluginCompanion;
	conversationId?: string;
	fileAccess?: OpenedFileAccess;
	appPath?: string;
	globalEntry?: boolean;
}) {
	const tl = useLiteralMessages();
	const hostActive = useIsActiveTab();
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const [agentId, setAgentId] = useState("");
	const [activation, setActivation] = useState<
		| {
				key: string;
				phase: "pending";
				conversationId?: string;
		  }
		| { key: string; phase: "failed"; conversationId?: string; error: string }
		| { key: string; phase: "ready"; part: McpAppPart }
		| null
	>(null);
	const requestLifetime = useRef<AbortController | null>(null);
	const idempotencyKey = useMemo(
		() => crypto.randomUUID(),
		[
			companion.mcpToolId,
			target.url,
			target.token,
			target.userJwt,
			agentId,
			conversationId,
			fileAccess?.uri,
		]
	);
	const currentActivation =
		activation?.key === idempotencyKey ? activation : null;
	const part =
		currentActivation?.phase === "ready" ? currentActivation.part : null;
	const pendingConversationId =
		currentActivation && currentActivation.phase !== "ready"
			? currentActivation.conversationId
			: undefined;
	const owningConversationId =
		part?.data?.conversationId ?? pendingConversationId ?? conversationId;
	const parentOwnsForms = useMcpFormsOwned(target, owningConversationId);
	const hostsConversation = Boolean(
		globalEntry && owningConversationId && !conversationId && !fileAccess
	);
	const pending = currentActivation?.phase === "pending";
	const error =
		currentActivation?.phase === "failed" ? currentActivation.error : null;
	const { data: agents = [], error: agentsError } = useQuery({
		queryKey: ["mcp-app-agents", target.url, target.token, target.userJwt],
		queryFn: () => fetchAgents(target),
	});
	useEffect(() => {
		setAgentId("");
	}, [target.url, target.token, target.userJwt]);
	useEffect(() => {
		requestLifetime.current?.abort();
		setActivation(null);
		return () => requestLifetime.current?.abort();
	}, [idempotencyKey]);
	const open = useCallback(async () => {
		if (!(companion.mcpToolId && agentId)) {
			return;
		}
		setActivation((previous) => ({
			key: idempotencyKey,
			phase: "pending",
			conversationId:
				previous?.key === idempotencyKey && previous.phase !== "ready"
					? previous.conversationId
					: undefined,
		}));
		const lifetime = new AbortController();
		requestLifetime.current?.abort();
		requestLifetime.current = lifetime;
		try {
			const opened = await openMcpApp(
				target,
				{
					idempotencyKey,
					toolId: companion.mcpToolId,
					agentId,
					conversationId,
					arguments: fileAccess
						? { file: { name: fileAccess.name, resourceUri: fileAccess.uri } }
						: {},
				},
				{
					signal: lifetime.signal,
					onPending: (id) => {
						if (id && !lifetime.signal.aborted) {
							setActivation({
								key: idempotencyKey,
								phase: "pending",
								conversationId: id,
							});
						}
					},
				}
			);
			if (globalEntry && !conversationId && !opened.data?.conversationId) {
				throw new Error("App activation did not return an owning conversation");
			}
			if (lifetime.signal.aborted) {
				return;
			}
			if (!(conversationId || opened.data?.conversationId) && opened.data) {
				opened.data.approvedGrants = opened.data.approvedGrants?.filter(
					(grant) => grant !== "ui:send_message"
				);
			}
			setActivation({ key: idempotencyKey, phase: "ready", part: opened });
		} catch (reason) {
			if (lifetime.signal.aborted) {
				return;
			}
			setActivation((previous) => ({
				key: idempotencyKey,
				phase: "failed",
				error: reason instanceof Error ? reason.message : "Could not open app",
				conversationId:
					previous?.key === idempotencyKey && previous.phase !== "ready"
						? previous.conversationId
						: undefined,
			}));
		}
	}, [
		target,
		companion.mcpToolId,
		agentId,
		conversationId,
		fileAccess,
		idempotencyKey,
		globalEntry,
	]);
	const host = useMemo<WidgetHostValue>(
		() => ({
			Renderer: AppWidget,
			env: {
				openExternal,
				proxyOrigin: target.url,
				appPath,
				appTitle: companion.label,
			},
			services: {
				fileAccess,
				callTool: (input) => widgetCallTool(target, input),
				setWidgetState: (input) => widgetSetState(target, input),
				sendFollowUpMessage: async (input) => {
					if (!owningConversationId) {
						throw new Error(
							"Open this app beside a conversation to send a message"
						);
					}
					const followUp = await widgetFollowUp(target, input);
					await sendChatBroadcastTurn(target, {
						conversationId: owningConversationId,
						text: followUp.injected.prompt,
						widgetFollowUpTicket: followUp.ticket,
					});
				},
				...(owningConversationId
					? {
							updateModelContext: async ({ owner, input }) =>
								useModelContextStore
									.getState()
									.update(
										`${target.url}:${owningConversationId}`,
										owner,
										input
									),
							getModelContext: (owner) =>
								useModelContextStore
									.getState()
									.get(`${target.url}:${owningConversationId}`, owner),
							clearModelContext: (owner) =>
								useModelContextStore.getState().clear(owner),
						}
					: undefined),
			},
		}),
		[target, owningConversationId, fileAccess, appPath, companion.label]
	);
	return (
		<div className="flex h-full min-h-0 flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center gap-3">
				<h2 className="font-medium text-sm">{companion.label}</h2>
				<span className="text-muted-foreground text-xs">
					{tl("Plugin · {pluginId}", { pluginId: companion.pluginId })}
				</span>
			</div>
			{hostsConversation && owningConversationId ? (
				<div
					className="grid min-h-0 flex-1 grid-rows-2 overflow-hidden rounded-lg border lg:grid-cols-2 lg:grid-rows-1"
					data-testid="mcp-app-thread-layout"
				>
					<section
						aria-label={companion.label}
						className="min-h-0 min-w-0 border-b p-2 lg:border-e lg:border-b-0"
					>
						{part ? (
							<WidgetHostContext.Provider value={host}>
								<AppWidget fill part={part} />
							</WidgetHostContext.Provider>
						) : pending ? (
							<div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
								<Spinner />
								Opening app
							</div>
						) : (
							<div className="flex h-full items-center justify-center">
								<Button
									onClick={() => {
										void open();
									}}
								>
									Retry opening app
								</Button>
							</div>
						)}
					</section>
					<section
						aria-label="App conversation"
						className="min-h-0 min-w-0 overflow-hidden"
					>
						<DockPageBoundary uid={`mcp-app-chat:${owningConversationId}`}>
							<Suspense
								fallback={
									<div className="flex h-full items-center justify-center">
										<Spinner />
									</div>
								}
							>
								<ChatPage
									initialAgent={agentId}
									mcpAppHost={hostActive}
									tabConversationId={owningConversationId}
								/>
							</Suspense>
						</DockPageBoundary>
					</section>
				</div>
			) : part ? (
				<WidgetHostContext.Provider value={host}>
					<AppWidget part={part} />
				</WidgetHostContext.Provider>
			) : (
				<>
					<label
						className="flex flex-col gap-2 text-sm"
						htmlFor={`mcp-app-agent-${companion.id}`}
					>
						Agent
						<NativeSelect
							disabled={pending}
							id={`mcp-app-agent-${companion.id}`}
							onChange={(event) => setAgentId(event.target.value)}
							value={agentId}
						>
							<NativeSelectOption value="">Choose an agent</NativeSelectOption>
							{agents.map((agent) => (
								<NativeSelectOption key={agent.id} value={agent.id}>
									{agent.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</label>
					<div>
						<Button
							disabled={!agentId || pending}
							onClick={() => {
								void open();
							}}
						>
							{pending ? <Spinner /> : null}Open app
						</Button>
					</div>
				</>
			)}
			{!(parentOwnsForms || hostsConversation) && owningConversationId ? (
				<McpForms
					conversationId={owningConversationId}
					enabled={hostActive}
					target={target}
				/>
			) : null}
			{error || agentsError ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error ??
						(agentsError instanceof Error
							? agentsError.message
							: "Could not load agents")}
				</p>
			) : null}
		</div>
	);
}
