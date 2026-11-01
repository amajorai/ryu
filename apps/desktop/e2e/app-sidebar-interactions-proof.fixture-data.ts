// Shared constants, types and Core fixture payloads for the AppSidebar
// interactions proof, split out of the spec so each file stays in its limits.
import { fileURLToPath } from "node:url";
import type { ChannelInput } from "../src/lib/api/channels.ts";
import type { Profile } from "../src/lib/api/identities.ts";
import type {
	SidebarFixtureSpace,
	SidebarProofJson,
	SidebarProofState,
} from "./app-sidebar-interactions-proof.contracts.ts";

export const STORY_URL = "/app-sidebar-interactions-proof.html";
export const EXPECTED_OPTIONAL_RESOURCE_URLS = new Set([
	"http://127.0.0.1:7989/control",
	"https://api.svgl.app/",
]);
export const EVIDENCE_DIRECTORY = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/app-sidebar-interactions/",
		import.meta.url
	)
);
export const PROJECT_PATH = "/Users/proof/Project Alpha";
export const DEFAULT_PROOF_HIDDEN_SECTIONS = [
	"channels",
	"integrations",
	"identities",
	"skills",
	"mcp",
	"tools",
	"engines",
	"plugins",
];
export const DEFAULT_PROOF_HIDDEN_CHROME: string[] = [];

export interface RecordedRequest {
	body: SidebarProofJson;
	method: string;
	path: string;
}

export interface ApiFixture {
	calendarEnabled: boolean;
	channels: ReturnType<typeof channelConfig>[];
	failChannelCreateOnce: boolean;
	failFolderCloneOnce: boolean;
	failFolderCreateOnce: boolean;
	failSkillReadCount: number;
	failSpaceCreateOnce: boolean;
	identities: Profile[];
	requests: RecordedRequest[];
	spaces: SidebarFixtureSpace[];
}

export interface ProofWindow extends Window {
	__APP_SIDEBAR_PROOF__?: SidebarProofState;
	__SIDEBAR_NATIVE_LEDGER__?: (call: {
		command: string;
		args: unknown;
	}) => Promise<void>;
}
declare global {
	interface Window {
		__APP_SIDEBAR_PROOF__?: SidebarProofState;
	}
}

export function jsonResponse<FixturePayload>(
	data: FixturePayload,
	status = 200
) {
	return {
		body: JSON.stringify(data),
		contentType: "application/json",
		status,
	};
}

export const EMPTY_CONTRIBUTIONS = {
	agent_edit_panels: [],
	channels: [],
	chat_features: [],
	companions: [],
	composer_controls: [],
	context_menu_items: [
		{
			anchor: "agent",
			args: { source: "sidebar" },
			capability: "proof.inspect-agent",
			id: "inspect-agent",
			label: "Inspect agent",
			order: 1,
			plugin: "proof-app",
		},
		{
			anchor: "record",
			args: { source: "sidebar" },
			capability: "proof.inspect-record",
			id: "inspect-record",
			label: "Inspect record",
			order: 1,
			plugin: "proof-app",
		},
	],
	create_actions: [],
	dock_panels: [],
	hook_events: [],
	live_activities: [],
	message_actions: [],
	output_styles: [],
	selection_actions: [],
	settings_tabs: [],
	sidebar_buttons: [
		{
			context: { collection: "proof" },
			icon: "lucide:library",
			id: "proof-home",
			order: 1,
			plugin: "proof-app",
			target: "/proof/home",
			title: "Proof home",
		},
	],
	sidebar_modes: [
		{
			default_section: "plugin:proof-app:proof-records",
			id: "proof-mode",
			order: 10,
			plugin: "proof-app",
			sections: ["plugin:proof-app:proof-records"],
			title: "Proof mode",
		},
	],
	sidebar_sections: [
		{
			approved_grants: ["ui:declarative-http"],
			http_policy: "core",
			id: "proof-records",
			order: 1,
			plugin: "proof-app",
			title: "Proof records",
			spec: {
				create: {
					http: {
						body: { name: "Created proof record" },
						method: "POST",
						path: "/api/proof/records",
					},
					label: "Create proof record",
					targetFrom: "id",
				},
				entity: { anchor: "record", idKey: "record_id" },
				itemActions: [
					{
						http: {
							body: { record_id: "{{item.id}}" },
							method: "POST",
							path: "/api/proof/records/{{item.id}}/archive",
						},
						id: "archive-record",
						label: "Archive proof record",
					},
				],
				itemTarget: "/proof/records/{{item.id}}",
				source: {
					http: { path: "/api/proof/records" },
					items: "records",
					map: { id: "id", subtitle: "summary", title: "name" },
				},
			},
		},
	],
	slash_commands: [],
	store_tabs: [],
	themes: [],
	turn_hooks: [],
	views: [],
	widget_apps: [],
};

export function channelConfig(
	id: string,
	name: string,
	input: Partial<ChannelInput> = {}
) {
	return {
		agentId: null,
		channelType: "telegram",
		createdAt: "2026-01-01T00:00:00.000Z",
		createdBy: "proof-user",
		credentialSource: "customer",
		enabled: true,
		groupAllowlist: [],
		groupPolicy: "allowlist",
		groupReplyMode: "mentions",
		groupUserAllowlist: [],
		id,
		lifecycleReactions: false,
		managedBotId: null,
		managedBotUsername: null,
		managedProvisioningState: null,
		model: null,
		name,
		organizationId: null,
		proactiveOpening: false,
		proactiveTarget: null,
		profileDescription: null,
		profileName: null,
		profileShortBio: null,
		provisionedServerId: null,
		publishCommands: false,
		reactionLearning: undefined,
		richText: true,
		secrets: { bot_token: "***" },
		sendReadReceipts: false,
		streaming: false,
		systemPrompt: null,
		teamId: null,
		threadReplies: false,
		typingIndicator: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
		voiceReply: "never",
		...input,
	};
}
