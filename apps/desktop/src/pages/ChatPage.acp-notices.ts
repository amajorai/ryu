import type { StreamedAcpConfig } from "@ryu/blocks/composer/composer-acp-sections.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { useEffect, useMemo, useRef } from "react";
import {
	trustWorkspaces,
	WORKSPACE_TRUST_WARNING_FIELD,
} from "@/src/lib/api/preferences.ts";
import type { useChatAcpStream } from "./ChatPage.acp-stream.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { StreamedTurnControl } from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatAcpNoticesInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatAcpStream>;

/** ACP turn control, transcript notices, and config warnings. */
export function useChatAcpNotices({
	messages,
	latestStreamedAcpConfigOptions,
	setStreamedAcpConfigOptions,
	agentId,
	convId,
	setStreamedAcpConfig,
	lastAgentFoldersRef,
	chatTarget,
}: UseChatAcpNoticesInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// A native provider publishes this part only for the active user turn. Stop
	// at the newest user message so a completed prior turn can never re-arm the
	// affordance when the next request starts before its first data part arrives.
	const latestTurnControl = useMemo<StreamedTurnControl | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "user") {
				return null;
			}
			if (message.role !== "assistant" || !message.parts) {
				continue;
			}
			for (let j = message.parts.length - 1; j >= 0; j--) {
				const part = message.parts[j];
				if (part.type !== "data-ryu-turn-control") {
					continue;
				}
				const data =
					/* SAFETY: This turn-control view keeps every slot unknown; turnId, startedAtMs, phase and strategy are checked before use. */ part.data as
						| {
								effort?: unknown;
								phase?: unknown;
								startedAtMs?: unknown;
								strategy?: unknown;
								turnId?: unknown;
						  }
						| undefined;
				if (
					!(isNativeText(data?.turnId) && isNativeNumber(data.startedAtMs)) ||
					(data.phase !== "reasoning" && data.phase !== "answering") ||
					data.strategy !== "native"
				) {
					continue;
				}
				return {
					effort: isNativeText(data.effort) ? data.effort : undefined,
					phase: data.phase,
					startedAtMs: data.startedAtMs,
					strategy: "native",
					turnId: data.turnId,
				};
			}
		}
		return null;
	}, [messages]);

	// ACP session metadata and Core context compaction are transcript-level
	// events. Show the newest one as a compact marker after the conversation;
	// neither is assistant prose and neither should be copied into the reply.
	const latestAcpTranscriptNotice = useMemo<{
		description?: string;
		id: string;
		title: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant" || !message.parts) {
				continue;
			}
			for (let j = message.parts.length - 1; j >= 0; j--) {
				const part = message.parts[j];
				if (part.type === "data-ryu-agent-control") {
					const data =
						/* SAFETY: The matching agent-control tag selects the optional slots; each displayed field is admitted by isNativeText before trimming. */ part.data as
							| {
									effective_agent_id?: unknown;
									effective_effort?: unknown;
									effective_model?: unknown;
							  }
							| undefined;
					const effectiveAgent = isNativeText(data?.effective_agent_id)
						? data.effective_agent_id.trim()
						: "";
					const effectiveModel = isNativeText(data?.effective_model)
						? data.effective_model.trim()
						: "";
					const effectiveEffort = isNativeText(data?.effective_effort)
						? data.effective_effort.trim()
						: "";
					const details = [
						effectiveAgent ? `agent: ${effectiveAgent}` : null,
						effectiveModel ? `model: ${effectiveModel}` : null,
						effectiveEffort ? `effort: ${effectiveEffort}` : null,
					].filter((detail): detail is string => detail !== null);
					return {
						description: details.length > 0 ? details.join(" · ") : undefined,
						id: `${message.id}:${j}`,
						title: "Agent control applied",
					};
				}
				if (part.type === "data-ryu-acp-compaction") {
					const data =
						/* SAFETY: Only the optional summary slot is observed, and isNativeText admits it before display. */ part.data as
							| { summary?: unknown }
							| undefined;
					return {
						description: isNativeText(data?.summary) ? data.summary : undefined,
						id: `${message.id}:${j}`,
						title: "Earlier context was compacted",
					};
				}
				if (part.type === "data-ryu-acp-session-info") {
					const data =
						/* SAFETY: The session-info tag selects optional unknown slots; native text checks admit title and updatedAt before use. */ part.data as
							| { title?: unknown; updatedAt?: unknown }
							| undefined;
					const title =
						isNativeText(data?.title) && data.title.trim()
							? tlRef.current("Agent session: {title}", {
									title: data.title.trim(),
								})
							: "Agent session updated";
					const updatedAt = isNativeText(data?.updatedAt)
						? data.updatedAt
						: undefined;
					if (title || updatedAt) {
						return {
							description: updatedAt,
							id: `${message.id}:${j}`,
							title,
						};
					}
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (latestStreamedAcpConfigOptions) {
			setStreamedAcpConfigOptions(latestStreamedAcpConfigOptions);
		}
	}, [latestStreamedAcpConfigOptions]);
	// An option list belongs to the agent that published it. Switching agent (or
	// thread) must drop it, or the new agent's pickers would keep rendering the
	// previous agent's options — the memo above only ever SETS, so a stale value
	// would otherwise survive until something else published.
	// agentId/convId are the reset triggers, not read in the body.
	useEffect(() => {
		setStreamedAcpConfigOptions(null);
	}, [agentId, convId]);

	// Agent-requested session-config write-backs, the exact same shape one level up
	// from the mode sync. Core streams `data-ryu-acp-config` (`{ config }`) when a
	// tool result asked the client to change values it holds and re-sends every
	// turn — an approved `ExitPlanMode` clearing the Plan mode pill is the shipped
	// case. Most recent part wins; the composer hook adopts and persists it.
	//
	// Carries the EMISSION key (`messageId:partIndex`), exactly like the config
	// warning below, because the identity that must be deduped is "this part", not
	// "this value": a second plan cycle in one conversation re-emits the byte-identical
	// `{"ryu.plan":"off"}`, and a value-keyed guard would swallow it and leave the
	// pill armed — the very bug this channel exists to fix. The key also preserves
	// what a value-keyed guard gave us: this memo re-runs on every stream chunk and
	// hands back a fresh object, but a later chunk re-derives the SAME key, so the
	// effect no-ops and a manual pick made mid-stream is never stomped.
	const latestStreamedAcpConfig = useMemo<StreamedAcpConfig | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-acp-config") {
					continue;
				}
				const data =
					/* SAFETY: Core ConfigUpdate is BTreeMap<String, String>; the matching acp-config envelope exposes that string-to-string map. */ part.data as
						| { config?: Record<string, string> }
						| undefined;
				const config = data?.config;
				if (config && Object.keys(config).length > 0) {
					return { key: `${m.id}:${j}`, config };
				}
			}
		}
		return null;
	}, [messages]);
	const lastStreamedAcpConfigRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			!latestStreamedAcpConfig ||
			latestStreamedAcpConfig.key === lastStreamedAcpConfigRef.current
		) {
			return;
		}
		lastStreamedAcpConfigRef.current = latestStreamedAcpConfig.key;
		setStreamedAcpConfig(latestStreamedAcpConfig);
	}, [latestStreamedAcpConfig]);

	// Non-fatal config warnings. Core streams `data-ryu-acp-config-warning` when a
	// session control the user chose (e.g. a model pick) was not accepted by the
	// agent. Surface the newest unseen one as a transient toast so the user isn't
	// silently misled. A ref tracks the last shown warning so re-renders don't
	// re-toast the same one.
	const lastConfigWarningRef = useRef<string | null>(null);
	const latestConfigWarning = useMemo<{
		field: string;
		key: string;
		message: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-ryu-acp-config-warning") {
					continue;
				}
				const data =
					/* SAFETY: Core ConfigWarning owns Rust String fields for field, requested and message; the matching tag selects its serialized payload. */ part.data as
						| { field?: string; message?: string; requested?: string }
						| undefined;
				const message = data?.message?.trim();
				if (message) {
					return { field: data?.field ?? "", key: `${m.id}:${j}`, message };
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (
			latestConfigWarning &&
			latestConfigWarning.key !== lastConfigWarningRef.current
		) {
			lastConfigWarningRef.current = latestConfigWarning.key;
			const folders = lastAgentFoldersRef.current;
			if (
				latestConfigWarning.field === WORKSPACE_TRUST_WARNING_FIELD &&
				folders.length > 0
			) {
				toast.warning({
					title: "This folder isn't trusted",
					description: latestConfigWarning.message,
					duration: null,
					button: {
						title: "Trust folder",
						onClick: () => {
							trustWorkspaces(chatTarget, folders)
								.then((saved) => {
									if (!saved) {
										toast.error({ title: "Could not trust the folder" });
										return;
									}
									toast.success({
										title: "Folder trusted",
										description:
											"The agent restarts without these limits on your next message.",
									});
								})
								.catch(() => {
									toast.error({ title: "Could not trust the folder" });
								});
						},
					},
				});
				return;
			}
			toast.warning({
				title: "Agent didn't apply a setting",
				description: latestConfigWarning.message,
			});
		}
	}, [chatTarget, latestConfigWarning]);
	return { latestTurnControl, latestAcpTranscriptNotice } as const;
}
