import {
	type BrowserRuntimeStatus,
	createBrowserLocalRuntime,
	DEFAULT_BROWSER_MODEL_ID,
} from "@ryu/browser-local-ai";
import type { SyntheticEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantPanelProps } from "./assistant-panel.tsx";
import { runAssistantTurn } from "./assistant-turn.ts";
import type { BrowserPageContext } from "./browser-context.ts";
import { buildBrowserContextMessage, findRelevantDocs } from "./docs.ts";
import { fetchGuestChatAvailable } from "./guest-chat.ts";
import {
	checkLocalNode,
	type LocalNodeConfig,
	type LocalNodeHealth,
	validateNodeUrl,
} from "./local-node.ts";
import {
	type WidgetError,
	widgetError,
	widgetInfoBar,
} from "./public-widget-errors.ts";
import { type AssistantMode, DEFAULT_NODE_URL } from "./runtime-controls.tsx";
import {
	type ActiveRequest,
	type AssistantMessage,
	clearStoredNode,
	messageId,
	nodeSummary,
	readStoredNode,
	storeNode,
	toChatMessage,
} from "./session-helpers.ts";
import type { WebMcpPageTool } from "./webmcp.ts";

/** Everything the panel needs except what the launcher shell owns. */
export type AssistantSessionPanelState = Omit<
	AssistantPanelProps,
	"browserContext" | "onClose" | "pageTools" | "poweredByRyu"
>;

interface AssistantSessionOptions {
	/** Captures the page synchronously, for the turn being sent. */
	capturePage: () => BrowserPageContext;
	docsBaseUrl?: string;
	initialMode: AssistantMode;
}

/** Chat state, runtimes and actions for one Ask Ryu session. */
export function useAssistantSession({
	capturePage,
	docsBaseUrl,
	initialMode,
}: AssistantSessionOptions): AssistantSessionPanelState {
	const [mode, setMode] = useState<AssistantMode>(initialMode);
	// Optimistic for a guest-first embed; corrected by the site's status check.
	const [guestAvailable, setGuestAvailable] = useState(initialMode === "guest");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<WidgetError | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [runtimeStatus, setRuntimeStatus] = useState<BrowserRuntimeStatus>();
	const [nodeUrl, setNodeUrl] = useState(DEFAULT_NODE_URL);
	const [nodeToken, setNodeToken] = useState("");
	const [allowRemote, setAllowRemote] = useState(false);
	const [rememberNode, setRememberNode] = useState(false);
	const [nodeConnected, setNodeConnected] = useState(false);
	const [nodeHealth, setNodeHealth] = useState<LocalNodeHealth>();
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const [includePageContext, setIncludePageContext] = useState(false);
	const [includeSelectionContext, setIncludeSelectionContext] = useState(false);
	const activeRequestRef = useRef<ActiveRequest | null>(null);
	const [runtime] = useState(() =>
		createBrowserLocalRuntime({ onStatus: setRuntimeStatus })
	);

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

	// Runs when the session mounts: on first open, never on page load.
	useEffect(() => {
		const controller = new AbortController();
		fetchGuestChatAvailable(controller.signal).then((available) => {
			if (!controller.signal.aborted) {
				setGuestAvailable(available);
			}
		});
		return () => controller.abort();
	}, []);

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
			setError(widgetError("browser-model", cause));
		} finally {
			setBusy(false);
		}
	}, [runtime]);

	const connectNode = useCallback(
		async (event: SyntheticEvent<HTMLFormElement>) => {
			event.preventDefault();
			setError(null);
			setNotice(null);
			setBusy(true);
			// Address validation already speaks in sentences; a failed check does not.
			let checking = false;
			try {
				const baseUrl = validateNodeUrl(nodeUrl, allowRemote);
				checking = true;
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
				setError(widgetError(checking ? "node" : "node-address", cause));
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
					text: `${tool.title ?? tool.name} result from ${tool.origin ?? "the current page"} (untrusted page content):\n${result}`,
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
			const currentContext = capturePage();
			const userContent = buildBrowserContextMessage(
				question,
				currentContext,
				includePageContext,
				includeSelectionContext
			);
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
			const setAnswerText = (text: string) =>
				setMessages((current) =>
					current.map((message) =>
						message.id === assistantId ? { ...message, text } : message
					)
				);

			try {
				const result = await runAssistantTurn({
					mode,
					modelReady,
					node: nodeConnected
						? { baseUrl: nodeUrl, token: nodeToken.trim() || null }
						: null,
					onText: (text) => {
						if (isCurrentRequest()) {
							setAnswerText(text);
						}
					},
					question,
					references,
					runtime,
					signal: controller.signal,
					userContent,
				});
				if (!isCurrentRequest()) {
					return;
				}
				setAnswerText(result.answer);
				setNotice(result.notice);
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
				setError(widgetError("answer", cause, question));
			} finally {
				if (isCurrentRequest()) {
					activeRequestRef.current = null;
					setBusy(false);
				}
			}
		},
		[
			busy,
			capturePage,
			includePageContext,
			includeSelectionContext,
			mode,
			modelReady,
			nodeConnected,
			nodeToken,
			nodeUrl,
			runtime,
		]
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

	const retryQuestion = error?.question;
	let retry: (() => void) | undefined;
	if (retryQuestion !== undefined) {
		retry = () => void submitQuestion(retryQuestion);
	} else if (error?.kind === "browser-model") {
		retry = () => void prepareBrowserModel();
	}
	const infoBar = widgetInfoBar({
		clearError: () => setError(null),
		clearNotice: () => setNotice(null),
		error,
		notice,
		retry,
	});

	// No title until there is a thread: the empty start greets instead.
	const title =
		messages.find((message) => message.role === "user")?.text.trim() ?? "";

	return {
		allowRemote,
		browserStatus,
		busy,
		guestAvailable,
		includePageContext,
		includeSelectionContext,
		infoBar,
		messages: chatMessages,
		mode,
		nodeConnected,
		nodeHealth,
		nodeToken,
		nodeUrl,
		onAllowRemoteChange: setAllowRemote,
		onBrowserPrepare: () => void prepareBrowserModel(),
		onConnect: (event) => void connectNode(event),
		onDisconnect: disconnectNode,
		onIncludePageContextChange: setIncludePageContext,
		onIncludeSelectionContextChange: setIncludeSelectionContext,
		onModeChange: selectMode,
		onNodeTokenChange: setNodeToken,
		onNodeUrlChange: setNodeUrl,
		onPageToolResult: handlePageToolResult,
		onRememberNodeChange: setRememberNode,
		onSend: ({ content }) => void submitQuestion(content),
		onStop: stop,
		rememberNode,
		status: busy ? "streaming" : "ready",
		title,
	};
}
