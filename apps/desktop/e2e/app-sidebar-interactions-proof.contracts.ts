import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { z } from "zod";
import type { ChannelInput } from "../src/lib/api/channels.ts";
import type { CreateConnectionInput } from "../src/lib/api/identities.ts";

export const sidebarProofJsonSchema = appResponseValueSchema;
export type SidebarProofJson = z.output<typeof sidebarProofJsonSchema>;
function preserveSidebarInput<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			sidebarProofJsonSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
// Complete native createConnection input, including its optional source.
export const sidebarIdentityRequestSchema = preserveSidebarInput(
	z.looseObject({
		domain: z.string(),
		profile_id: z.string(),
		source: z.string().optional(),
	})
) satisfies z.ZodType<CreateConnectionInput>;
// Complete ChannelInput owner: every optional behavior/credential field is decoded.
export const sidebarChannelRequestSchema = preserveSidebarInput(
	z.looseObject({
		channelType: z.enum([
			"telegram",
			"slack",
			"whatsapp",
			"whatsapp_personal",
			"discord",
			"bluebubbles",
		]),
		name: z.string(),
		agentId: z.string().nullable().optional(),
		enabled: z.boolean().optional(),
		groupReplyMode: z.enum(["mentions", "all"]).optional(),
		model: z.string().nullable().optional(),
		platformOptions: z.record(z.string(), sidebarProofJsonSchema).optional(),
		secrets: z.record(z.string(), z.string()).optional(),
		systemPrompt: z.string().nullable().optional(),
		teamId: z.string().nullable().optional(),
		dmAllowlist: z.array(z.string()).optional(),
		dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
		groupAllowlist: z.array(z.string()).optional(),
		groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
		groupUserAllowlist: z.array(z.string()).optional(),
		lifecycleReactions: z.boolean().optional(),
		proactiveOpening: z.boolean().optional(),
		proactiveTarget: z.string().nullable().optional(),
		profileDescription: z.string().nullable().optional(),
		profileName: z.string().nullable().optional(),
		profileShortBio: z.string().nullable().optional(),
		publishCommands: z.boolean().optional(),
		reactionLearning: z
			.looseObject({
				allowGroup: z.boolean(),
				enabled: z.boolean(),
				negativeEmoji: z.array(z.string()),
				positiveEmoji: z.array(z.string()),
			})
			.optional(),
		richText: z.boolean().optional(),
		sendReadReceipts: z.boolean().optional(),
		streaming: z.boolean().optional(),
		threadReplies: z.boolean().optional(),
		typingIndicator: z.boolean().optional(),
		voiceReply: z.enum(["never", "mirror", "always"]).optional(),
	})
) satisfies z.ZodType<ChannelInput>;
export const sidebarCreateSpaceSchema = preserveSidebarInput(
	z.looseObject({
		name: z.string(),
		description: z.string().nullable(),
		retrieval_mode: z.enum(["graph", "vector"]).optional(),
		visibility: z.enum(["org", "private", "team"]).optional(),
	})
);
export const sidebarSpaceVisibilitySchema = preserveSidebarInput(
	z.looseObject({
		visibility: z.enum(["org", "private", "team"]),
		team_id: z.string().optional(),
	})
);
export const sidebarNewFolderSchema = preserveSidebarInput(
	z.looseObject({ name: z.string() })
);
export const sidebarCloneFolderSchema = preserveSidebarInput(
	z.looseObject({ url: z.string(), name: z.string().optional() })
);
export const sidebarImportScanSchema = preserveSidebarInput(
	z.looseObject({ path: z.string() })
);
export const sidebarImportRunSchema = preserveSidebarInput(
	z.looseObject({
		path: z.string(),
		items: z.array(
			z.looseObject({
				id: z.string(),
				kind: z.enum([
					"instructions",
					"skill",
					"mcp_server",
					"plugin",
					"memory",
					"agent",
					"slash_command",
				]),
			})
		),
	})
);
export const sidebarStringsSchema = preserveSidebarInput(z.array(z.string()));
export const sidebarTabSnapshotSchema = preserveSidebarInput(
	z.looseObject({
		activeTabId: z.string(),
		tabs: z.array(
			z.looseObject({
				conversationId: z.string().nullable(),
				forceNew: z.boolean(),
				id: z.string(),
				path: z.string(),
				title: z.string(),
			})
		),
	})
);

// Full local space rows emitted by this fixture, matching Core's SpaceWire fields.
const sidebarSpaceFieldsSchema = z.looseObject({
	created_at: z.number(),
	description: z.string().nullable().optional(),
	document_count: z.number(),
	icon: sidebarProofJsonSchema.optional(),
	id: z.string(),
	name: z.string(),
	retrieval_mode: z.string().optional(),
	system: z.boolean().optional(),
	team_id: z.string().nullable().optional(),
	updated_at: z.number(),
	visibility: z.string().optional(),
});
export type SidebarFixtureSpace = z.output<typeof sidebarSpaceFieldsSchema>;
// The icon fixture echoes the complete JSON carrier, without claiming a decoded GlyphValue.
export const sidebarIconRequestSchema = preserveSidebarInput(
	z.looseObject({ icon: sidebarProofJsonSchema.optional() })
).nullable();
export const sidebarThreadImportSchema = preserveSidebarInput(
	z.looseObject({ thread_id: z.string(), dry_run: z.boolean() })
);

// Complete TabsContext PersistedSession writer envelope. Glyphs remain lossless
// JSON here because restoration, rather than this observer, owns their admission.
type SidebarPersistedSplit =
	| { i: number }
	| { c: SidebarPersistedSplit[]; o: "columns" | "rows"; s: number[] };
const sidebarPersistedSplitSchema: z.ZodType<SidebarPersistedSplit> = z.lazy(
	() =>
		z.union([
			z.looseObject({ i: z.number() }),
			z.looseObject({
				c: z.array(sidebarPersistedSplitSchema),
				o: z.enum(["columns", "rows"]),
				s: z.array(z.number()),
			}),
		])
);
const sidebarWorkspaceDockSchema = z.looseObject({
	activeIndex: z.number(),
	tabs: z.array(
		z.looseObject({
			kind: z.string(),
			label: z.string(),
			pinned: z.boolean().optional(),
			project: z.boolean().optional(),
			uid: z.string().optional(),
		})
	),
});
const sidebarWorkspaceSnapshotSchema = z.looseObject({
	bottom: sidebarWorkspaceDockSchema,
	bottomOpen: z.boolean(),
	right: sidebarWorkspaceDockSchema,
	rightOpen: z.boolean(),
});
const sidebarPersistedSessionSchema = preserveSidebarInput(
	z.looseObject({
		activeIndex: z.number(),
		splits: z.array(sidebarPersistedSplitSchema).optional(),
		tabs: z.array(
			z.looseObject({
				conversationId: z.string().optional(),
				icon: sidebarProofJsonSchema.optional(),
				id: z.string().optional(),
				initialAgent: z.string().optional(),
				initialProject: z.string().optional(),
				path: z.string(),
				pinned: z.boolean().optional(),
				title: z.string(),
				workspaceSession: sidebarWorkspaceSnapshotSchema.optional(),
				worktreeMode: z.boolean().optional(),
			})
		),
	})
).nullable();
export function sidebarPersistedConversationIds(value: SidebarProofJson) {
	return sidebarPersistedSessionSchema
		.parse(value)
		?.tabs.map((tab) => tab.conversationId);
}

/** Exact local SDK recorder/state installed by this fixture before page loading. */
export interface SidebarProofState {
	callbackId: number;
	nativeCalls: Array<{ args: InvokeArgs | null; command: string }>;
	quickPreviewId: string | null;
	quickReplyId: string | null;
}
