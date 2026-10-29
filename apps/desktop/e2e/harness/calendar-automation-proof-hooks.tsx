import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";

const fixtureAgents: AgentSummary[] = [
	{
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: false,
		createdAt: null,
		description: null,
		engine: null,
		id: "agent-daily",
		installed: null,
		installHint: null,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: false,
		model: null,
		name: "Daily Brief",
		recommended: false,
		safetyProfile: "autonomous",
		systemPrompt: null,
		title: "",
		transport: null,
		version: "1.0.0",
		versionStatus: null,
	},
	{
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: false,
		createdAt: null,
		description: null,
		engine: null,
		id: "agent-release",
		installed: null,
		installHint: null,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: false,
		model: null,
		name: "Release Watch",
		recommended: false,
		safetyProfile: "autonomous",
		systemPrompt: null,
		title: "",
		transport: null,
		version: "1.0.0",
		versionStatus: null,
	},
];

const createdAt = Date.parse("2026-10-01T07:00:00.000Z");
const fixtureConversations: Conversation[] = [
	{
		agentId: "agent-daily",
		createdAt,
		id: "chat-daily-primary",
		messageCount: 8,
		messages: [],
		title: "Morning planning",
		updatedAt: createdAt,
	},
	{
		agentId: "agent-release",
		createdAt: createdAt - 60_000,
		id: "chat-release-primary",
		messageCount: 4,
		messages: [],
		title: "Release notes",
		updatedAt: createdAt - 60_000,
	},
	{
		agentId: "agent-release",
		createdAt: createdAt - 120_000,
		id: "chat-release-secondary",
		messageCount: 3,
		messages: [],
		title: "Release checklist",
		updatedAt: createdAt - 120_000,
	},
	{
		agentId: "agent-daily",
		createdAt: createdAt - 3_600_000,
		id: "chat-daily-secondary",
		messageCount: 2,
		messages: [],
		title: "Editorial review",
		updatedAt: createdAt - 3_600_000,
	},
];

export function useActiveNode(): Node {
	return {
		name: "browser-fixture",
		token: null,
		url: window.location.origin,
		userJwt: null,
	};
}

export function useAgents() {
	return { agents: fixtureAgents };
}

export function useChatHistoryContext() {
	return { conversations: fixtureConversations };
}
