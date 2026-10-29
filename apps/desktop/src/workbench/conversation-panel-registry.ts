import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import type { ContextPanelView } from "@/src/components/panels/ContextPanel.tsx";
import type { CoworkContextPanelProps } from "@/src/components/panels/CoworkContextPanel.tsx";
import type { SubagentView } from "@/src/components/panels/WorkspacePanels.tsx";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";

/**
 * The live data a chat's own panels read (context usage, cowork messages and
 * callbacks). The mounted chat publishes it under its conversation id, so a
 * Context or Sources tab placed anywhere in the workbench shows that chat's
 * data — and never another chat's.
 */
export interface ConversationPanelSource {
	/** The agent-activity view, when the chat has an individual agent. */
	agentActivityPanel?: ReactNode | null;
	/** Artifacts this chat opened in a panel, by artifact id. */
	artifacts?: Readonly<Record<string, ArtifactView>>;
	contextView: ContextPanelView | null;
	cowork: CoworkContextPanelProps | undefined;
	/** The raw message part the inspector panel shows. */
	inspectorView?: unknown;
	/** Clear the subagent the Subagents panel is focused on (back to the list). */
	onClearSubagentView?: () => void;
	/** The subagent the Subagents panel is focused on, if any. */
	subagentView?: SubagentView | null;
}

interface Registration {
	source: ConversationPanelSource;
	token: symbol;
}

const sources = new Map<string, Registration>();
const listeners = new Map<string, Set<() => void>>();

function notify(conversationId: string): void {
	for (const listener of listeners.get(conversationId) ?? []) {
		listener();
	}
}

/**
 * Publish a chat's panel data. Returns an unregister function that removes the
 * entry only while it is still this registration's, so a second view of the
 * same chat closing cannot erase the one still open.
 */
export function registerConversationPanelSource(
	conversationId: string,
	source: ConversationPanelSource,
	token: symbol = Symbol(conversationId)
): () => void {
	sources.set(conversationId, { source, token });
	notify(conversationId);
	return () => {
		if (sources.get(conversationId)?.token === token) {
			sources.delete(conversationId);
			notify(conversationId);
		}
	};
}

export function getConversationPanelSource(
	conversationId: string
): ConversationPanelSource | undefined {
	return sources.get(conversationId)?.source;
}

function subscribe(conversationId: string, listener: () => void): () => void {
	let set = listeners.get(conversationId);
	if (!set) {
		set = new Set();
		listeners.set(conversationId, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
		if (set?.size === 0) {
			listeners.delete(conversationId);
		}
	};
}

const NO_SOURCE = () => undefined;
const NO_SUBSCRIPTION = () => () => undefined;

/** The live source for a conversation, re-rendering only for that id. */
export function useConversationPanelSource(
	conversationId: string | null
): ConversationPanelSource | undefined {
	const subscribeToSource = useCallback(
		(listener: () => void) =>
			conversationId ? subscribe(conversationId, listener) : NO_SUBSCRIPTION(),
		[conversationId]
	);
	const readSource = useCallback(
		() =>
			conversationId ? getConversationPanelSource(conversationId) : NO_SOURCE(),
		[conversationId]
	);
	return useSyncExternalStore(subscribeToSource, readSource);
}

/** Replace a registration's data in place, if that registration still owns it. */
function updateConversationPanelSource(
	conversationId: string,
	source: ConversationPanelSource,
	token: symbol
): void {
	const current = sources.get(conversationId);
	if (current?.token === token && current.source !== source) {
		sources.set(conversationId, { source, token });
		notify(conversationId);
	}
}

/**
 * Keep a chat's source published while it is mounted. Called by the chat's
 * dock host with its live props on every render: the registration follows the
 * conversation id, and newer data replaces the old in place (no gap in which
 * a workbench tab would read "closed").
 */
export function usePublishConversationPanelSource(
	conversationId: string | null | undefined,
	source: ConversationPanelSource
): void {
	const latest = useRef(source);
	latest.current = source;
	const token = useRef<symbol | null>(null);
	useEffect(() => {
		if (!conversationId) {
			return;
		}
		const registration = Symbol(conversationId);
		token.current = registration;
		const unregister = registerConversationPanelSource(
			conversationId,
			latest.current,
			registration
		);
		return () => {
			token.current = null;
			unregister();
		};
	}, [conversationId]);
	useEffect(() => {
		if (conversationId && token.current) {
			updateConversationPanelSource(conversationId, source, token.current);
		}
	}, [conversationId, source]);
}
