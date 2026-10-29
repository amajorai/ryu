import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import type { UIMessage } from "ai";
import type { useAssistantStore } from "../../src/store/useAssistantStore.ts";
import type { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import type { ProofJsonRecord } from "../fixture-json.ts";

const recent = [
	{
		id: "recent-proof",
		title: "Workspace review",
		updatedAt: Date.now(),
		archived: false,
	},
];
const history = {
	createConversation: <Options,>(id: string, options: Options) => {
		window.__assistantProof.calls.push({ kind: "create", id, options });
	},
	listConversations: () => recent,
	seedTitleFromFirstMessage: (id: string, title: string) => {
		window.__assistantProof.calls.push({ kind: "title", id, title });
	},
	setActiveConversationId: (id: string) => {
		window.__assistantProof.calls.push({ kind: "active", id });
	},
	loadMessages: async (id: string) => {
		window.__assistantProof.calls.push({ kind: "load", id });
		return window.__assistantProof.history[id] ?? [];
	},
	refresh: () => {
		window.__assistantProof.calls.push({ kind: "refresh" });
	},
};
export function useChatHistoryContext() {
	return history;
}
export function useTabsContext() {
	return {
		tabs: [{ id: "workspace", title: "Workspace", path: "/workspace" }],
		activeTabId: "workspace",
		openTab: <Options,>(path: string, options: Options) =>
			window.__assistantProof.calls.push({ kind: "tab", path, options }),
	};
}
// The panel renders outside every tab, where the real hook reads no
// CurrentTabIdContext provider.
export function useCurrentTabId(): string | undefined {
	return;
}
function proofNode() {
	return {
		url: window.location.origin,
		token: window.__assistantProof.token ?? "fixture-node-token",
		userJwt: null,
	};
}
export function useActiveNode() {
	return proofNode();
}
// Stable like the real `useCallback` getter; each call reads the current token.
export function useActiveNodeGetter() {
	return proofNode;
}
export function useBuilderRuntime() {
	return {
		agentId: "ryu",
		bodyFields: () => ({ agent_id: "ryu", model: "fixture-model" }),
	};
}
export function useAgents() {
	return { agents: [] };
}
export function useInterfaceLevel() {
	return "advanced";
}
export function useSidebarVariant() {
	return ["floating"];
}
export const sidebarFloatingChrome = "rounded-3xl ring-1 ring-border";
export function useTitleBarClearsContent() {
	return false;
}
export function useSpeechPlayback() {
	return { play: async () => {} };
}
export async function getRealtimeJwt() {
	return null;
}
export function ClipComposerControls() {
	return null;
}
export function useComposerSlot(
	_runtime: unknown,
	options: { surface?: string; voiceMode?: boolean }
) {
	// What each composer was asked to offer, so specs can check surface gating.
	window.__assistantProof.composers = {
		...window.__assistantProof.composers,
		[options.surface ?? "ask-ryu"]: { voiceMode: options.voiceMode ?? true },
	};
	return {
		inputBar: InputBar,
		attachments: [],
		composerMenuGroups: [],
		mentionItems: [],
		takeImages: () => undefined,
		takeClipText: () => "",
		attachClip: () => {},
		renderBody: () => null,
		triggerSections: [],
		voiceMode: undefined,
	};
}
declare global {
	interface Window {
		__assistantProof: {
			composers?: Record<string, { voiceMode: boolean }>;
			token?: string;
			calls: ProofJsonRecord[];
			history: Record<
				string,
				{
					id: string;
					role: string;
					content: string;
					metadata?: ProofJsonRecord;
					parts?: UIMessage["parts"];
				}[]
			>;
		};
		assistantStore: typeof useAssistantStore;
		workspaceStore: typeof useWorkspaceStore;
	}
}

export function useIsActiveTab() {
	return true;
}
