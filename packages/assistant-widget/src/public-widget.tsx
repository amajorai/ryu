"use client";

import {
	type BrowserRuntimeStatus,
	createBrowserLocalRuntime,
	DEFAULT_BROWSER_MODEL_ID,
	hasWebGpu,
} from "@ryu/browser-local-ai";
import { Button } from "@ryu/ui/components/button";
import { Logo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import type { ChatStatus, UIMessage } from "ai";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RyuAssistantChat } from "./chat";
import {
	type AssistantDocReference,
	buildLocalAssistantPrompt,
	deterministicAssistantAnswer,
	findRelevantDocs,
	resolveDocHref,
} from "./docs";
import {
	checkLocalNode,
	type LocalNodeConfig,
	type LocalNodeHealth,
	normalizeNodeUrl,
	runLocalNodeChat,
	validateNodeUrl,
} from "./local-node";
import { RyuAssistantMorph } from "./morph";
import { PageToolsPopover } from "./page-tools";
import {
	useWebMcpPageTools,
	type WebMcpPageTool,
	type WebMcpPageToolsState,
} from "./webmcp";

export type AssistantMode = "browser" | "node";

export interface RyuAssistantWidgetProps {
	/** Absolute docs origin for the marketing site; omit on Fumadocs. */
	docsBaseUrl?: string;
	initialMode?: AssistantMode;
	inline?: boolean;
	openOnMount?: boolean;
	showLauncher?: boolean;
}

interface AssistantMessage {
	id: string;
	references?: AssistantDocReference[];
	role: "assistant" | "user";
	text: string;
}

interface ActiveRequest {
	assistantId: string;
	controller: AbortController;
	id: string;
}

const NODE_SESSION_KEY = "ryu-assistant-node-v1";
const DEFAULT_NODE_URL = "http://127.0.0.1:7980";
const MORPH_CONTENT_HEIGHT = 620;
const MORPH_CONTENT_WIDTH = 400;

const MODE_OPTIONS: readonly {
	id: AssistantMode;
	label: string;
}[] = [
	{ id: "browser", label: "Browser" },
	{ id: "node", label: "Local node" },
];

function statusLabel(status: BrowserRuntimeStatus | undefined): string {
	if (!status || status.status === "not-prepared") {
		return "Not downloaded";
	}
	if (status.status === "preparing") {
		return status.progress == null
			? "Preparing"
			: `Downloading ${Math.round(status.progress)}%`;
	}
	if (status.status === "ready") {
		return "Ready in this browser";
	}
	return "Could not prepare";
}

function readStoredNode(): { baseUrl: string; token: string | null } | null {
	try {
		const raw = sessionStorage.getItem(NODE_SESSION_KEY);
		if (!raw) {
			return null;
		}
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object") {
			return null;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.baseUrl !== "string") {
			return null;
		}
		return {
			baseUrl: normalizeNodeUrl(record.baseUrl),
			token: typeof record.token === "string" ? record.token : null,
		};
	} catch {
		return null;
	}
}

function storeNode(config: LocalNodeConfig): void {
	try {
		sessionStorage.setItem(NODE_SESSION_KEY, JSON.stringify(config));
	} catch {
		// Private browsing can deny session storage; in-memory use still works.
	}
}

function clearStoredNode(): void {
	try {
		sessionStorage.removeItem(NODE_SESSION_KEY);
	} catch {
		// Nothing to clear when storage is unavailable.
	}
}

function nodeSummary(health: LocalNodeHealth): string {
	const version = health.version ? `Core ${health.version}` : "Core online";
	return health.channel ? `${version} · ${health.channel}` : version;
}

function messageId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function usableBrowserAnswer(answer: string, question: string): boolean {
	const normalized = answer.trim().toLowerCase();
	if (!normalized || normalized.length > 6000) {
		return false;
	}
	const roleLabels = normalized.match(/\b(system|user|assistant):/g) ?? [];
	if (roleLabels.length > 1 || normalized.includes("public context:")) {
		return false;
	}
	return normalized !== question.trim().toLowerCase();
}

function toChatMessage(
	message: AssistantMessage,
	docsBaseUrl: string | undefined,
	isBusy: boolean
): UIMessage {
	const text =
		message.text ||
		(isBusy && message.role === "assistant" ? "Thinking locally…" : "");
	const sourceLinks = message.references?.length
		? message.references
				.map(
					(reference) =>
						`[${reference.title}](${resolveDocHref(docsBaseUrl, reference.href)})`
				)
				.join(" · ")
		: "";
	const content = sourceLinks ? `${text}\n\nSources: ${sourceLinks}` : text;

	return {
		id: message.id,
		parts: [{ text: content, type: "text" }],
		role: message.role,
	} as UIMessage;
}

function ModeSwitcher({
	disabled,
	mode,
	onChange,
}: {
	disabled: boolean;
	mode: AssistantMode;
	onChange: (mode: AssistantMode) => void;
}) {
	return (
		<div
			aria-label="Assistant mode"
			className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
			role="group"
		>
			{MODE_OPTIONS.map((option) => (
				<button
					aria-pressed={mode === option.id}
					className={cn(
						"rounded-md px-2 py-1 font-medium text-[10px] transition-colors",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						mode === option.id
							? "bg-background text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground"
					)}
					disabled={disabled}
					key={option.id}
					onClick={() => onChange(option.id)}
					type="button"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

function RuntimeSetup({
	allowRemote,
	browserStatus,
	busy,
	compact = false,
	mode,
	nodeConnected,
	nodeHealth,
	nodeToken,
	nodeUrl,
	onAllowRemoteChange,
	onBrowserPrepare,
	onConnect,
	onDisconnect,
	onNodeTokenChange,
	onNodeUrlChange,
	onRememberNodeChange,
	rememberNode,
}: {
	allowRemote: boolean;
	browserStatus: BrowserRuntimeStatus | undefined;
	busy: boolean;
	compact?: boolean;
	mode: AssistantMode;
	nodeConnected: boolean;
	nodeHealth: LocalNodeHealth | undefined;
	nodeToken: string;
	nodeUrl: string;
	onAllowRemoteChange: (value: boolean) => void;
	onBrowserPrepare: () => void;
	onConnect: (event: FormEvent<HTMLFormElement>) => void;
	onDisconnect: () => void;
	onNodeTokenChange: (value: string) => void;
	onNodeUrlChange: (value: string) => void;
	onRememberNodeChange: (value: boolean) => void;
	rememberNode: boolean;
}) {
	const cardClassName = compact
		? "border-border/50 bg-card/50 px-3 py-2"
		: "border-border/70 bg-card/70 p-3";

	if (mode === "browser") {
		return (
			<div
				className={cn("rounded-xl border text-left shadow-sm", cardClassName)}
				data-testid="assistant-runtime-setup"
			>
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="font-medium text-foreground text-xs">Browser-local</p>
						<p className="mt-0.5 truncate text-[10px] text-muted-foreground">
							SmolLM2 135M · {hasWebGpu() ? "WebGPU → WASM" : "WASM runtime"}
						</p>
					</div>
					<span className="shrink-0 text-[10px] text-muted-foreground">
						{statusLabel(browserStatus)}
					</span>
				</div>
				{compact ? null : (
					<p className="mt-2 text-muted-foreground text-xs leading-relaxed">
						Questions run in this tab. The model is cached by this browser and
						no prompt is sent to Ryu servers.
					</p>
				)}
				<Button
					className={cn("w-full", compact ? "mt-2 h-7 text-[10px]" : "mt-3")}
					disabled={busy || browserStatus?.status === "ready"}
					onClick={onBrowserPrepare}
					size={compact ? "sm" : "default"}
					type="button"
				>
					{browserStatus?.status === "ready"
						? "Model ready"
						: busy
							? "Preparing…"
							: "Download local model"}
				</Button>
			</div>
		);
	}

	if (nodeConnected) {
		return (
			<div
				className={cn("rounded-xl border text-left shadow-sm", cardClassName)}
				data-testid="assistant-runtime-setup"
			>
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="font-medium text-foreground text-xs">Local node</p>
						<p className="mt-0.5 truncate text-[10px] text-muted-foreground">
							{nodeHealth ? nodeSummary(nodeHealth) : "Core online"} · direct
							browser connection
						</p>
					</div>
					<span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-600">
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-current"
						/>
						Online
					</span>
				</div>
				{compact ? null : (
					<p className="mt-2 text-muted-foreground text-xs leading-relaxed">
						Questions go directly from this tab to Core. Visitor turns use{" "}
						<code>persist: false</code> and do not enter the node's chat
						history.
					</p>
				)}
				<Button
					className={cn("w-full", compact ? "mt-2 h-7 text-[10px]" : "mt-3")}
					disabled={busy}
					onClick={onDisconnect}
					size={compact ? "sm" : "default"}
					type="button"
					variant="outline"
				>
					Disconnect this tab
				</Button>
			</div>
		);
	}

	return (
		<form
			className={cn("rounded-xl border text-left shadow-sm", cardClassName)}
			data-testid="assistant-runtime-setup"
			onSubmit={onConnect}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-foreground text-xs">
						Connect a local node
					</p>
					<p className="mt-0.5 text-[10px] text-muted-foreground">
						Direct, non-persistent Core chat
					</p>
				</div>
				<span className="shrink-0 text-[10px] text-muted-foreground">
					Not connected
				</span>
			</div>
			{compact ? null : (
				<p className="mt-2 text-muted-foreground text-xs leading-relaxed">
					The site never proxies your node credential. It calls the address you
					approve with the token you provide.
				</p>
			)}
			<div
				className={cn("flex flex-col", compact ? "mt-2 gap-2" : "mt-3 gap-2.5")}
			>
				<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
					Node address
					<input
						aria-label="Local Ryu node address"
						className="h-8 rounded-lg border border-border/70 bg-background/70 px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
						disabled={busy}
						onChange={(event) => onNodeUrlChange(event.target.value)}
						placeholder={DEFAULT_NODE_URL}
						spellCheck={false}
						type="url"
						value={nodeUrl}
					/>
				</label>
				<label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
					Node token <span>(optional for an unauthenticated dev node)</span>
					<input
						aria-label="Local Ryu node token"
						autoComplete="off"
						className="h-8 rounded-lg border border-border/70 bg-background/70 px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
						disabled={busy}
						onChange={(event) => onNodeTokenChange(event.target.value)}
						placeholder="Paste the node token"
						type="password"
						value={nodeToken}
					/>
				</label>
				<label className="flex items-start gap-2 text-[10px] text-muted-foreground leading-relaxed">
					<input
						checked={allowRemote}
						disabled={busy}
						onChange={(event) => onAllowRemoteChange(event.target.checked)}
						type="checkbox"
					/>
					<span>I trust this remote/LAN node and its network.</span>
				</label>
				<label className="flex items-start gap-2 text-[10px] text-muted-foreground leading-relaxed">
					<input
						checked={rememberNode}
						disabled={busy}
						onChange={(event) => onRememberNodeChange(event.target.checked)}
						type="checkbox"
					/>
					<span>Remember this connection for this tab only.</span>
				</label>
				<Button
					className="w-full"
					disabled={busy}
					size={compact ? "sm" : "default"}
					type="submit"
				>
					{busy ? "Testing…" : "Test & connect"}
				</Button>
			</div>
			{compact ? null : (
				<p className="mt-2.5 text-[10px] text-muted-foreground leading-relaxed">
					The token stays in memory unless you choose this tab's session
					storage. Core must allow this site origin in{" "}
					<code>RYU_CORS_ORIGINS</code>.
				</p>
			)}
		</form>
	);
}

function AssistantIntro({
	mode,
	pageToolCount,
}: {
	mode: AssistantMode;
	pageToolCount: number;
}) {
	return (
		<div className="flex items-center gap-3 px-1 text-left">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
				<Logo size="24px" variant="eyes" />
			</span>
			<div>
				<p className="font-medium text-foreground text-sm">Choose a runtime</p>
				<p className="mt-0.5 max-w-[280px] text-muted-foreground text-xs leading-relaxed">
					{pageToolCount > 0
						? `${pageToolCount} page tool${pageToolCount === 1 ? "" : "s"} available above. Run one when you need the current page to act.`
						: mode === "browser"
							? "Run a small model in this tab, or switch to your own Ryu Core node."
							: "Connect a running Ryu Core node, or switch to browser-local mode."}
				</p>
			</div>
		</div>
	);
}

interface AssistantPanelProps {
	actions: ReactNode;
	allowRemote: boolean;
	browserStatus: BrowserRuntimeStatus | undefined;
	busy: boolean;
	error?: Error;
	infoBar?: {
		description?: string;
		onClose?: () => void;
		variant?: "default" | "destructive";
	};
	messages: UIMessage[];
	mode: AssistantMode;
	nodeConnected: boolean;
	nodeHealth: LocalNodeHealth | undefined;
	nodeToken: string;
	nodeUrl: string;
	onAllowRemoteChange: (value: boolean) => void;
	onBrowserPrepare: () => void;
	onClose?: () => void;
	onConnect: (event: FormEvent<HTMLFormElement>) => void;
	onDisconnect: () => void;
	onNodeTokenChange: (value: string) => void;
	onNodeUrlChange: (value: string) => void;
	onPageToolResult: (tool: WebMcpPageTool, result: string) => void;
	onRememberNodeChange: (value: boolean) => void;
	onSend: (message: { content: string; role: "user" }) => void;
	onStop: () => void;
	pageTools: WebMcpPageToolsState;
	rememberNode: boolean;
	status: ChatStatus;
}

function AssistantPanel({
	actions,
	allowRemote,
	browserStatus,
	busy,
	error,
	infoBar,
	messages,
	mode,
	nodeConnected,
	nodeHealth,
	nodeToken,
	nodeUrl,
	onAllowRemoteChange,
	onBrowserPrepare,
	onClose,
	onConnect,
	onDisconnect,
	onNodeTokenChange,
	onNodeUrlChange,
	onRememberNodeChange,
	onSend,
	onStop,
	onPageToolResult,
	pageTools,
	rememberNode,
	status,
}: AssistantPanelProps) {
	const setupProps = {
		allowRemote,
		browserStatus,
		busy,
		mode,
		nodeConnected,
		nodeHealth,
		nodeToken,
		nodeUrl,
		onAllowRemoteChange,
		onBrowserPrepare,
		onConnect,
		onDisconnect,
		onNodeTokenChange,
		onNodeUrlChange,
		onRememberNodeChange,
		rememberNode,
	};

	return (
		<div className="dark h-full w-full">
			<RyuAssistantChat
				actions={
					<div className="flex items-center gap-1">
						<PageToolsPopover
							onExecute={(tool, input) => pageTools.execute(tool.name, input)}
							onResult={onPageToolResult}
							tools={pageTools.tools}
						/>
						{actions}
					</div>
				}
				assistantAvatar={<Logo size="20px" variant="eyes" />}
				assistantName="Ryu"
				assistantTitle={mode === "browser" ? "Browser-local" : "Local node"}
				composerDisabled={
					busy ||
					(mode === "browser"
						? browserStatus?.status !== "ready"
						: !nodeConnected)
				}
				composerFooter={<RuntimeSetup {...setupProps} compact />}
				density="compact"
				emptyStateHeader={
					<AssistantIntro mode={mode} pageToolCount={pageTools.tools.length} />
				}
				emptyStatePosition="center"
				error={error}
				footer={<RuntimeSetup {...setupProps} />}
				infoBar={infoBar}
				messages={messages}
				minimal
				onClose={onClose}
				onSend={onSend}
				onStop={onStop}
				placement="floating"
				showCopyToolbar={false}
				status={status}
				title="Ask Ryu"
			/>
		</div>
	);
}

export function RyuAssistantWidget({
	docsBaseUrl,
	initialMode = "browser",
	inline = false,
	openOnMount = false,
	showLauncher = true,
}: RyuAssistantWidgetProps) {
	const [open, setOpen] = useState(openOnMount || inline);
	const [mode, setMode] = useState<AssistantMode>(initialMode);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [runtimeStatus, setRuntimeStatus] = useState<BrowserRuntimeStatus>();
	const [nodeUrl, setNodeUrl] = useState(DEFAULT_NODE_URL);
	const [nodeToken, setNodeToken] = useState("");
	const [allowRemote, setAllowRemote] = useState(false);
	const [rememberNode, setRememberNode] = useState(false);
	const [nodeConnected, setNodeConnected] = useState(false);
	const [nodeHealth, setNodeHealth] = useState<LocalNodeHealth>();
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const activeRequestRef = useRef<ActiveRequest | null>(null);
	const [runtime] = useState(() =>
		createBrowserLocalRuntime({ onStatus: setRuntimeStatus })
	);
	const pageTools = useWebMcpPageTools();

	useEffect(
		() => () => {
			activeRequestRef.current?.controller.abort();
		},
		[]
	);

	const modelReady = runtimeStatus?.status === "ready";
	const browserStatus =
		runtimeStatus ?? runtime.getStatus(DEFAULT_BROWSER_MODEL_ID);
	const chatMessages = useMemo(
		() => messages.map((message) => toChatMessage(message, docsBaseUrl, busy)),
		[messages, docsBaseUrl, busy]
	);

	useEffect(() => runtime.subscribe(setRuntimeStatus), [runtime]);

	useEffect(() => {
		const stored = readStoredNode();
		if (!stored) {
			return;
		}
		setNodeUrl(stored.baseUrl);
		setNodeToken(stored.token ?? "");
		setRememberNode(true);
		setNotice("A node address is ready to test in this tab.");
	}, []);

	const stop = useCallback(() => {
		const activeRequest = activeRequestRef.current;
		if (activeRequest) {
			activeRequest.controller.abort();
			activeRequestRef.current = null;
			setMessages((current) =>
				current.filter((message) => message.id !== activeRequest.assistantId)
			);
			setNotice("The current answer was stopped.");
		}
		setBusy(false);
	}, []);

	const prepareBrowserModel = useCallback(async () => {
		setError(null);
		setNotice(null);
		setBusy(true);
		try {
			await runtime.prepare(DEFAULT_BROWSER_MODEL_ID);
			setNotice(
				"The model is cached in this browser. Questions stay in this tab."
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The browser model could not load."
			);
		} finally {
			setBusy(false);
		}
	}, [runtime]);

	const connectNode = useCallback(
		async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			setNotice(null);
			setBusy(true);
			try {
				const baseUrl = validateNodeUrl(nodeUrl, allowRemote);
				const config: LocalNodeConfig = {
					baseUrl,
					token: nodeToken.trim() || null,
				};
				const health = await checkLocalNode(config);
				setNodeUrl(baseUrl);
				setNodeHealth(health);
				setNodeConnected(true);
				if (rememberNode) {
					storeNode(config);
				}
				setNotice(`${nodeSummary(health)} · direct browser connection`);
			} catch (cause) {
				setNodeConnected(false);
				setNodeHealth(undefined);
				setError(
					cause instanceof Error
						? cause.message
						: "The node could not be connected."
				);
			} finally {
				setBusy(false);
			}
		},
		[allowRemote, nodeToken, nodeUrl, rememberNode]
	);

	const disconnectNode = useCallback(() => {
		setNodeConnected(false);
		setNodeHealth(undefined);
		setNodeToken("");
		setRememberNode(false);
		clearStoredNode();
		setNotice("The local node token was removed from this tab.");
	}, []);

	const handlePageToolResult = useCallback(
		(tool: WebMcpPageTool, result: string) => {
			setMessages((current) => [
				...current,
				{
					id: messageId("page-tool"),
					role: "assistant",
					text: `${tool.title ?? tool.name} result (untrusted page content):\n${result}`,
				},
			]);
			setNotice(
				`Ran page tool ${tool.name}. Review its result as page content.`
			);
		},
		[]
	);

	const submitQuestion = useCallback(
		async (content: string) => {
			const question = content.trim();
			if (!question || busy) {
				return;
			}
			setError(null);
			setNotice(null);
			const references = findRelevantDocs(question);
			const assistantId = messageId("answer");
			const requestId = messageId("request");
			const controller = new AbortController();
			activeRequestRef.current = { assistantId, controller, id: requestId };
			setMessages((current) => [
				...current,
				{ id: messageId("question"), role: "user", text: question },
				{ id: assistantId, references, role: "assistant", text: "" },
			]);
			setBusy(true);

			const isCurrentRequest = () =>
				activeRequestRef.current?.id === requestId &&
				!controller.signal.aborted;

			try {
				if (mode === "browser") {
					if (!modelReady) {
						await runtime.prepare(DEFAULT_BROWSER_MODEL_ID);
					}
					const result = await runtime.generate(
						{
							messages: [
								{
									content: buildLocalAssistantPrompt(question, references),
									role: "system",
								},
								{ content: question, role: "user" },
							],
							modelId: DEFAULT_BROWSER_MODEL_ID,
						},
						controller.signal
					);
					if (!isCurrentRequest()) {
						return;
					}
					const generatedAnswer = result.text.trim();
					const modelAnswerIsUsable = usableBrowserAnswer(
						generatedAnswer,
						question
					);
					const answer = modelAnswerIsUsable
						? generatedAnswer
						: deterministicAssistantAnswer(question, references);
					setMessages((current) =>
						current.map((message) =>
							message.id === assistantId
								? { ...message, text: answer }
								: message
						)
					);
					setNotice(
						modelAnswerIsUsable
							? "Answered locally · no prompt was sent to Ryu servers."
							: "Answered locally with public-document grounding."
					);
					return;
				}

				if (!nodeConnected) {
					throw new Error(
						"Connect a local Ryu node before sending a question."
					);
				}
				const config: LocalNodeConfig = {
					baseUrl: nodeUrl,
					token: nodeToken.trim() || null,
				};
				let streamedAnswer = "";
				const answer = await runLocalNodeChat(
					config,
					[
						{
							content: buildLocalAssistantPrompt(question, references),
							role: "system",
						},
						{ content: question, role: "user" },
					],
					{
						onDelta(delta) {
							if (!isCurrentRequest()) {
								return;
							}
							streamedAnswer += delta;
							setMessages((current) =>
								current.map((message) =>
									message.id === assistantId
										? { ...message, text: streamedAnswer }
										: message
								)
							);
						},
						signal: controller.signal,
					}
				);
				if (!isCurrentRequest()) {
					return;
				}
				setMessages((current) =>
					current.map((message) =>
						message.id === assistantId
							? {
									...message,
									text:
										answer ||
										deterministicAssistantAnswer(question, references),
								}
							: message
					)
				);
				setNotice(
					"Answered by your local Ryu Core node · this visitor turn was not persisted."
				);
			} catch (cause) {
				if (!isCurrentRequest()) {
					return;
				}
				setMessages((current) =>
					current.filter((message) => message.id !== assistantId)
				);
				if (cause instanceof Error && cause.name === "AbortError") {
					return;
				}
				setError(
					cause instanceof Error
						? cause.message
						: "The assistant could not answer."
				);
			} finally {
				if (isCurrentRequest()) {
					activeRequestRef.current = null;
					setBusy(false);
				}
			}
		},
		[busy, mode, modelReady, nodeConnected, nodeToken, nodeUrl, runtime]
	);

	const selectMode = useCallback(
		(nextMode: AssistantMode) => {
			if (busy) {
				return;
			}
			setMode(nextMode);
			setError(null);
			setNotice(null);
		},
		[busy]
	);

	const infoBar = error
		? {
				description: error,
				onClose: () => setError(null),
				variant: "destructive" as const,
			}
		: notice
			? {
					description: notice,
					onClose: () => setNotice(null),
				}
			: undefined;

	const panel = (
		<AssistantPanel
			actions={
				<ModeSwitcher disabled={busy} mode={mode} onChange={selectMode} />
			}
			allowRemote={allowRemote}
			browserStatus={browserStatus}
			busy={busy}
			error={error ? new Error(error) : undefined}
			infoBar={infoBar}
			messages={chatMessages}
			mode={mode}
			nodeConnected={nodeConnected}
			nodeHealth={nodeHealth}
			nodeToken={nodeToken}
			nodeUrl={nodeUrl}
			onAllowRemoteChange={setAllowRemote}
			onBrowserPrepare={() => void prepareBrowserModel()}
			onClose={inline ? undefined : () => setOpen(false)}
			onConnect={(event) => void connectNode(event)}
			onDisconnect={disconnectNode}
			onNodeTokenChange={setNodeToken}
			onNodeUrlChange={setNodeUrl}
			onPageToolResult={handlePageToolResult}
			onRememberNodeChange={setRememberNode}
			onSend={({ content }) => void submitQuestion(content)}
			onStop={stop}
			pageTools={pageTools}
			rememberNode={rememberNode}
			status={(busy ? "streaming" : "ready") as ChatStatus}
		/>
	);

	if (inline) {
		return <div className="h-[620px] w-full">{panel}</div>;
	}

	if (!(showLauncher || open)) {
		return null;
	}

	return (
		<RyuAssistantMorph
			bgClassName="bg-gradient-to-b from-neutral-950/95 via-neutral-950/90 to-neutral-900/85 text-neutral-100"
			chromeClassName="ring-1 ring-white/10 shadow-2xl"
			className="fixed z-[1000000001] h-10 w-10"
			contentHeight={MORPH_CONTENT_HEIGHT}
			contentMaxHeight="calc(100svh - 2rem)"
			contentMaxWidth="calc(100vw - 2rem)"
			contentWidth={MORPH_CONTENT_WIDTH}
			isOpen={open}
			onOpenChange={setOpen}
			style={{ bottom: "1.5rem", right: "1.5rem", zIndex: 1_000_000_001 }}
			trigger={<Logo className="text-neutral-100" size="34px" variant="eyes" />}
			triggerClassName="text-neutral-100 transition-transform duration-200 hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			triggerLabel="Open Ask Ryu"
		>
			{panel}
		</RyuAssistantMorph>
	);
}
