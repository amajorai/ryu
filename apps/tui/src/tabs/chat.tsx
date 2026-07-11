/* @jsxImportSource @opentui/react */
// Chat tab - the reference tab implementation. Matches apps/cli chat parity
// (apps/cli/src/{main.rs,chat.rs,app.rs}):
//   - multi-turn streaming via POST /api/chat/stream (AI SDK v6 UI Message Stream
//     SSE), one client-minted conversation_id per chat
//   - streaming text-delta rendering + inline tool-call loop surfacing
//   - agent picker (Ctrl+A)
//   - /btw <q>          side question (POST /api/btw), dismissible overlay
//   - /goal <text>      pass-through: Core's server-side goal turn-hook owns it
//   - /proof <text>     pass-through: Core's server-side proof turn-hook owns it
//   - /check            arm per-turn double-check via plugin_flags; Core reviews
//                       and emits the critique as a plugin note (overlay)
//   - /model <id>       ACP model override (acp_model); /model clears
//   - /team <id>        route to a team (team_id, wins over agent); /team clears
//   - /sessions         run-history overlay for the conversation
//   - /new (Ctrl+L)     start a fresh chat (new conversation_id)
//
// Keyboard ownership: while active, the composer (native <input>) owns character
// input and this tab reports inputFocused=true so the shell suppresses its
// plain-key globals. Enter, Ctrl+A, Ctrl+L and overlay navigation are handled in
// this tab's own gated useKeyboard. termcn components are used for presentation;
// interactive keys are owned here (we pass collapsible=false where a termcn
// component would otherwise register its own greedy handler).

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { fetchAgents } from "@ryuhq/core-client/agents";
import { askBtw } from "@ryuhq/core-client/btw";
import {
	listSessionsForConversation,
	type Session,
} from "@ryuhq/core-client/sessions";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Markdown } from "@/components/ui/markdown.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useChatIntent } from "../core/ChatIntentContext.tsx";
import { useCore } from "../core/CoreContext.tsx";
import {
	type ChatStreamOptions,
	type ChatTurn,
	streamChat,
} from "../core/chatStream.ts";
import { useSetInputFocused } from "../core/InputFocusContext.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

const WHITESPACE = /\s+/;

type Role = "user" | "assistant";

interface Message {
	content: string;
	id: number;
	role: Role;
}

type Overlay =
	| { kind: "none" }
	| { kind: "agents"; agents: { id: string; name: string }[]; index: number }
	| { kind: "sessions"; sessions: Session[] }
	| { kind: "btw"; question: string; answer: string | null }
	| { kind: "plugin_note"; notes: string[] };

let nextMessageId = 1;

export function ChatTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const setInputFocused = useSetInputFocused();
	const { pending: chatIntent, clear: clearChatIntent } = useChatIntent();

	const [messages, setMessages] = useState<Message[]>([]);
	const [composer, setComposer] = useState("");
	const [streaming, setStreaming] = useState(false);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
	const [acpModel, setAcpModel] = useState<string | null>(null);
	const [doubleCheckOn, setDoubleCheckOn] = useState(false);
	const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });

	const conversationIdRef = useRef<string>(crypto.randomUUID());
	const abortRef = useRef<AbortController | null>(null);
	// The live transcript, read by `send` so a turn always ships the up-to-date
	// history rather than a value frozen in send's closure.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;

	const overlayOpen = overlay.kind !== "none";

	// While active, the composer owns the keyboard; tell the shell to suppress its
	// plain-key globals. Release on blur/unmount.
	useEffect(() => {
		setInputFocused(active);
		return () => setInputFocused(false);
	}, [active, setInputFocused]);

	const resetChat = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		conversationIdRef.current = crypto.randomUUID();
		setMessages([]);
		setComposer("");
		setStreaming(false);
		setOverlay({ kind: "none" });
		notify("Started a new chat", "info");
	}, [notify]);

	const buildOptions = useCallback((): ChatStreamOptions => {
		const conversationId = conversationIdRef.current;
		// Arm Core's double-check turn-hook for this turn when the toggle is on.
		const pluginFlags = doubleCheckOn
			? { "io.ryu.double-check": true }
			: undefined;
		// Team routing wins over a single agent (parity with apps/cli).
		if (selectedTeam) {
			return {
				conversationId,
				teamId: selectedTeam,
				acpModel: acpModel ?? undefined,
				pluginFlags,
			};
		}
		return {
			conversationId,
			agentId: selectedAgent ?? undefined,
			acpModel: acpModel ?? undefined,
			pluginFlags,
		};
	}, [selectedTeam, selectedAgent, acpModel, doubleCheckOn]);

	// Append a delta to the streaming assistant message (always the last one).
	const appendToLast = useCallback((delta: string) => {
		setMessages((prev) => {
			if (prev.length === 0) {
				return prev;
			}
			const last = prev.at(-1);
			if (last?.role !== "assistant") {
				return prev;
			}
			const updated = { ...last, content: last.content + delta };
			return [...prev.slice(0, -1), updated];
		});
	}, []);

	// Append a plugin note (goal/proof/double-check hook output) into the note
	// overlay, accumulating across the several notes a single turn can emit.
	const pushPluginNote = useCallback((text: string) => {
		setOverlay((o) =>
			o.kind === "plugin_note"
				? { kind: "plugin_note", notes: [...o.notes, text] }
				: { kind: "plugin_note", notes: [text] }
		);
	}, []);

	// Core send path: append the user + empty assistant message and stream into the
	// assistant message. Goal/proof/double-check now run as Core server-side
	// turn-hooks; their output arrives as `data-plugin_note` frames (pushPluginNote).
	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				return;
			}
			// Prior turns (read live from the ref for up-to-date history) plus this
			// user turn.
			const priorTurns: ChatTurn[] = messagesRef.current.map((m) => ({
				role: m.role,
				content: m.content,
			}));
			const turns: ChatTurn[] = [
				...priorTurns,
				{ role: "user", content: trimmed },
			];

			setMessages((prev) => [
				...prev,
				{ id: nextMessageId++, role: "user", content: trimmed },
				{ id: nextMessageId++, role: "assistant", content: "" },
			]);
			setStreaming(true);

			const controller = new AbortController();
			abortRef.current = controller;

			streamChat(
				target,
				turns,
				buildOptions(),
				{
					onTextDelta: appendToLast,
					onToolInput: (name) => appendToLast(`\n[tool: ${name}]\n`),
					onToolOutput: (status) => appendToLast(`[tool ${status}]\n`),
					onPluginNote: pushPluginNote,
					onError: (message) => {
						appendToLast(`\n[error: ${message}]`);
						notify(message, "error");
					},
					onDone: () => {
						/* finalize handled after the promise resolves */
					},
				},
				controller.signal
			)
				.then(() => {
					setStreaming(false);
					abortRef.current = null;
				})
				.catch((err: unknown) => {
					setStreaming(false);
					abortRef.current = null;
					notify(errText(err), "error");
				});
		},
		[target, buildOptions, appendToLast, pushPluginNote, notify]
	);

	const openAgentPicker = useCallback(() => {
		fetchAgents(target)
			.then((agents) =>
				setOverlay({
					kind: "agents",
					agents: agents.map((a) => ({ id: a.id, name: a.name })),
					index: 0,
				})
			)
			.catch((err: unknown) =>
				notify(`agents failed: ${errText(err)}`, "error")
			);
	}, [target, notify]);

	const runBtw = useCallback(
		(arg: string) => {
			if (arg.length === 0) {
				notify("usage: /btw <question>", "warning");
				return;
			}
			setOverlay({ kind: "btw", question: arg, answer: null });
			askBtw(target, conversationIdRef.current, arg)
				.then((res) =>
					setOverlay({ kind: "btw", question: arg, answer: res.answer })
				)
				.catch((err: unknown) => {
					setOverlay({ kind: "none" });
					notify(`btw failed: ${errText(err)}`, "error");
				});
		},
		[target, notify]
	);

	const runTeam = useCallback(
		(arg: string) => {
			if (arg.length === 0 || arg === "clear") {
				setSelectedTeam(null);
				notify("Team routing cleared", "info");
				return;
			}
			setSelectedTeam(arg);
			setSelectedAgent(null);
			notify(`Team: ${arg}`, "info");
		},
		[notify]
	);

	const runSessions = useCallback(() => {
		listSessionsForConversation(target, conversationIdRef.current)
			.then((sessions) => setOverlay({ kind: "sessions", sessions }))
			.catch((err: unknown) =>
				notify(`sessions failed: ${errText(err)}`, "error")
			);
	}, [target, notify]);

	const toggleDoubleCheck = useCallback(() => {
		setDoubleCheckOn((on) => {
			notify(on ? "Double-check off" : "Double-check armed", "info");
			return !on;
		});
	}, [notify]);

	// Slash-command dispatch. Returns true when the input was a command (handled),
	// false when it should be sent as a normal chat message. Each branch delegates
	// to a focused handler so this stays a thin router.
	const handleCommand = useCallback(
		(raw: string): boolean => {
			const text = raw.trim();
			if (!text.startsWith("/")) {
				return false;
			}
			const [cmd, ...rest] = text.slice(1).split(WHITESPACE);
			const arg = rest.join(" ").trim();
			// /goal and /proof are owned by Core's server-side turn-hooks: let them
			// through as normal chat messages (not handled here).
			if (cmd === "goal" || cmd === "proof") {
				return false;
			}
			switch (cmd) {
				case "new":
				case "newchat":
					resetChat();
					break;
				case "btw":
				case "b":
					runBtw(arg);
					break;
				case "check":
				case "double-check":
					toggleDoubleCheck();
					break;
				case "model":
					setAcpModel(arg.length > 0 ? arg : null);
					notify(
						arg.length > 0 ? `Model: ${arg}` : "Model override cleared",
						"info"
					);
					break;
				case "team":
					runTeam(arg);
					break;
				case "sessions":
					runSessions();
					break;
				case "agent":
					openAgentPicker();
					break;
				default:
					notify(`Unknown command: /${cmd}`, "warning");
					break;
			}
			return true;
		},
		[
			notify,
			resetChat,
			runBtw,
			runTeam,
			runSessions,
			openAgentPicker,
			toggleDoubleCheck,
		]
	);

	const submitComposer = useCallback(() => {
		const text = composer;
		setComposer("");
		if (handleCommand(text)) {
			return;
		}
		if (streaming) {
			notify("Still streaming - wait for the current turn", "warning");
			return;
		}
		send(text);
	}, [composer, handleCommand, streaming, send, notify]);

	// Apply a palette-issued chat intent once this tab is active. The palette can
	// target chat actions while another tab is focused, so it records an intent and
	// jumps here (see ChatIntentContext); we consume it on activation.
	useEffect(() => {
		if (!(active && chatIntent)) {
			return;
		}
		if (chatIntent === "new") {
			resetChat();
		} else if (chatIntent === "sessions") {
			runSessions();
		} else if (chatIntent === "toggle-check") {
			toggleDoubleCheck();
		}
		clearChatIntent();
	}, [
		active,
		chatIntent,
		clearChatIntent,
		resetChat,
		runSessions,
		toggleDoubleCheck,
	]);

	// Agent-picker overlay navigation. Plain function (re-created each render) so it
	// always sees the current overlay without stale-closure deps.
	const handleAgentKey = (key: KeyEvent) => {
		if (overlay.kind !== "agents") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "agents" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "agents"
					? { ...o, index: Math.min(o.agents.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const chosen = overlay.agents[overlay.index];
			if (chosen) {
				setSelectedAgent(chosen.id);
				setSelectedTeam(null);
				notify(`Agent: ${chosen.name}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	// Keys while composing (no overlay open).
	const handleComposeKey = (key: KeyEvent) => {
		if (key.ctrl && key.name === "a") {
			openAgentPicker();
		} else if (key.ctrl && key.name === "l") {
			resetChat();
		} else if (key.name === "return") {
			submitComposer();
		} else if (key.name === "escape" && streaming) {
			abortRef.current?.abort();
			setStreaming(false);
		}
	};

	// Tab-owned keyboard, gated on active. Routes to overlay or compose handlers.
	useKeyboard((key) => {
		if (!active) {
			return;
		}
		if (overlay.kind === "agents") {
			handleAgentKey(key);
			return;
		}
		// btw / sessions / doublecheck overlays are read-only - any of esc/enter/space
		// dismisses them.
		if (overlay.kind !== "none") {
			if (
				key.name === "escape" ||
				key.name === "return" ||
				key.name === "space"
			) {
				setOverlay({ kind: "none" });
			}
			return;
		}
		handleComposeKey(key);
	});

	const composerFocused = active && !overlayOpen;

	return (
		<box flexDirection="column" flexGrow={1}>
			<Transcript messages={messages} streaming={streaming} />
			<StatusLine
				agent={selectedAgent}
				doubleCheckOn={doubleCheckOn}
				model={acpModel}
				streaming={streaming}
				team={selectedTeam}
			/>
			<box
				borderColor={
					composerFocused ? theme.colors.focusRing : theme.colors.border
				}
				borderStyle="rounded"
				flexDirection="row"
				gap={1}
				paddingLeft={1}
				paddingRight={1}
			>
				<text fg={theme.colors.primary}>{"›"}</text>
				<input
					cursorColor={theme.colors.primary}
					focused={composerFocused}
					onChange={setComposer}
					placeholder="Message, or /btw /goal /proof /check /model /team /sessions /new (Ctrl+A agent, Ctrl+L new)"
					placeholderColor={theme.colors.mutedForeground}
					textColor={theme.colors.foreground}
					value={composer}
				/>
			</box>
			{overlay.kind === "none" ? null : <OverlayView overlay={overlay} />}
		</box>
	);
}

function Transcript({
	messages,
	streaming,
}: {
	messages: Message[];
	streaming: boolean;
}) {
	const theme = useTheme();
	if (messages.length === 0) {
		return (
			<box flexGrow={1} paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>
					Ask anything. Slash commands - /btw /goal /proof /check /model /team
					/sessions /new.
				</text>
			</box>
		);
	}
	return (
		<scrollbox flexGrow={1} paddingLeft={1} paddingTop={1}>
			{messages.map((message, i) => {
				const isLast = i === messages.length - 1;
				const isStreamingAssistant =
					isLast && streaming && message.role === "assistant";
				return (
					<box flexDirection="column" key={message.id} marginBottom={1}>
						<text
							fg={
								message.role === "user"
									? theme.colors.primary
									: theme.colors.success
							}
						>
							<b>{message.role === "user" ? "you" : "assistant"}</b>
						</text>
						{message.content.length > 0 ? (
							<Markdown>{message.content}</Markdown>
						) : (
							<text fg={theme.colors.mutedForeground}>
								{isStreamingAssistant ? "…" : ""}
							</text>
						)}
					</box>
				);
			})}
		</scrollbox>
	);
}

function StatusLine({
	agent,
	team,
	model,
	doubleCheckOn,
	streaming,
}: {
	agent: string | null;
	team: string | null;
	model: string | null;
	doubleCheckOn: boolean;
	streaming: boolean;
}) {
	const chips: { key: string; label: string }[] = [];
	if (team) {
		chips.push({ key: "team", label: `team:${team}` });
	} else if (agent) {
		chips.push({ key: "agent", label: `agent:${agent}` });
	}
	if (model) {
		chips.push({ key: "model", label: `model:${model}` });
	}
	if (doubleCheckOn) {
		chips.push({ key: "dc", label: "double-check" });
	}
	if (chips.length === 0 && !streaming) {
		return null;
	}
	return (
		<box flexDirection="row" gap={1} paddingLeft={1}>
			{streaming ? (
				<StatusMessage variant="loading">streaming</StatusMessage>
			) : null}
			{chips.map((chip) => (
				<Badge bordered={false} key={chip.key} variant="secondary">
					{chip.label}
				</Badge>
			))}
		</box>
	);
}

function OverlayView({ overlay }: { overlay: Overlay }) {
	const theme = useTheme();
	if (overlay.kind === "agents") {
		return (
			<box padding={1}>
				<Card
					subtitle="↑/↓ move · Enter choose · Esc cancel"
					title="Select agent"
				>
					{overlay.agents.length === 0 ? (
						<text fg={theme.colors.mutedForeground}>No agents</text>
					) : (
						overlay.agents.map((agentItem, i) => (
							<box flexDirection="row" gap={1} key={agentItem.id}>
								<text
									fg={
										i === overlay.index
											? theme.colors.primary
											: theme.colors.muted
									}
								>
									{i === overlay.index ? "›" : " "}
								</text>
								<text
									fg={
										i === overlay.index
											? theme.colors.primary
											: theme.colors.foreground
									}
								>
									{agentItem.name}
								</text>
							</box>
						))
					)}
				</Card>
			</box>
		);
	}
	if (overlay.kind === "sessions") {
		return (
			<box padding={1}>
				<Card subtitle="Esc to close" title="Sessions">
					{overlay.sessions.length === 0 ? (
						<text fg={theme.colors.mutedForeground}>No runs yet</text>
					) : (
						overlay.sessions.map((session) => (
							<box flexDirection="row" gap={1} key={session.id}>
								<text fg={theme.colors.foreground}>{session.runnableKind}</text>
								<text fg={theme.colors.mutedForeground}>
									{session.runnableId}
								</text>
								<Badge bordered={false} variant="secondary">
									{session.status}
								</Badge>
							</box>
						))
					)}
				</Card>
			</box>
		);
	}
	if (overlay.kind === "btw") {
		return (
			<box padding={1}>
				<Card subtitle={overlay.question} title="btw">
					{overlay.answer === null ? (
						<StatusMessage variant="loading">thinking…</StatusMessage>
					) : (
						<Markdown>{overlay.answer}</Markdown>
					)}
				</Card>
			</box>
		);
	}
	if (overlay.kind === "plugin_note") {
		return (
			<box padding={1}>
				<Card subtitle="from a plugin hook · Esc to close" title="Note">
					{overlay.notes.map((note, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only text with no stable id
						<Markdown key={i}>{note}</Markdown>
					))}
				</Card>
			</box>
		);
	}
	return null;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
