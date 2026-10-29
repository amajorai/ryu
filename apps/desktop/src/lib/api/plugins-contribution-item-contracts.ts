// Per-surface plugin contribution schemas (agent panels through live
// activities), composed by `plugins-contribution-response-contracts.ts`.

import {
	LIVE_ACTIVITY_STATUSES,
	type LiveActivityAudioSpec,
	type LiveActivityContribution,
	type LiveActivitySourceMap,
	type LiveActivitySpec,
	type LiveActivityStatus,
} from "@ryu/app-host/live-activity";
import {
	type ContributionHttpPolicy,
	viewSourceSchema,
} from "@ryu/app-host/views";
import { z } from "zod";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "./plugin-wire-values.ts";
import type {
	PluginAgentEditPanel,
	PluginAgentProfileTab,
	PluginChannel,
	PluginChatFeature,
	PluginChatWidgetTemplate,
	PluginCompanion,
	PluginCompanionCsp,
	PluginComposerControl,
	PluginComposerControlOption,
	PluginComputerUsePlanner,
	PluginContextMenuItem,
	PluginCreateAction,
	PluginDockPanel,
	PluginDockPlacement,
	PluginFileHandler,
	PluginHookEvent,
	PluginLiveActivity,
} from "./plugins.ts";

export const pluginAgentEditPanelResponseSchema = z
	.object({
		description: z.string().optional(),
		id: z.string(),
		plugin: z.string(),
		pref_key_prefix: z.string().optional(),
		title: z.string(),
		type: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginAgentEditPanel>;

export const pluginAgentProfileTabResponseSchema = z
	.object({
		companion: z.string(),
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginAgentProfileTab>;

export const pluginChannelResponseSchema = z
	.object({ id: z.string(), name: z.string(), platform: z.string() })
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginChannel>;

export const pluginChatFeatureResponseSchema = z
	.object({ plugin: z.string().optional() })
	.catchall(
		z.union([pluginValueSchema, z.undefined()])
	) satisfies z.ZodType<PluginChatFeature>;

export const pluginChatWidgetTemplateResponseSchema = z
	.object({
		availability: z.string().optional(),
		backing: z
			.object({
				tool_id: z.string().optional(),
				view_id: z.string().optional(),
			})
			.catchall(pluginValueSchema),
		description: z.string().optional(),
		display_mode: z.string(),
		examples: z.array(z.string()),
		id: z.string(),
		plugin: z.string().optional(),
		safe_action_ids: z.array(z.string()),
		title: z.string(),
		triggers: z.array(z.string()),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginChatWidgetTemplate>;

const pluginCompanionCspResponseSchema = z
	.object({
		connectDomains: z.array(z.string()),
		resourceDomains: z.array(z.string()),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginCompanionCsp>;

export const pluginCompanionResponseSchema = z
	.object({
		approvedGrants: z.array(z.string()),
		csp: pluginCompanionCspResponseSchema.optional(),
		defaultCspEnforced: z.boolean(),
		firstParty: z.boolean().optional(),
		hasUi: z.boolean(),
		icon: z.string().optional(),
		id: z.string(),
		label: z.string(),
		mcpToolId: z.string().optional(),
		name: z.string(),
		navigationVisible: z.boolean().optional(),
		pluginId: z.string(),
		shortcut: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginCompanion>;

const pluginComposerControlOptionResponseSchema = z
	.object({
		description: z.string().optional(),
		icon: z.string().optional(),
		label: z.string(),
		value: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginComposerControlOption>;

export const pluginComposerControlResponseSchema = z
	.object({
		args: pluginDocumentSchema.optional(),
		capability: z.string().optional(),
		default: z.string().optional(),
		description: z.string().optional(),
		flag: z.string(),
		http_policy: pluginValueSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		label: z.string(),
		options: z.array(pluginComposerControlOptionResponseSchema).optional(),
		order: z.number().optional(),
		placement: z.enum(["menu", "bar"]).optional(),
		plugin: z.string(),
		source: viewSourceSchema.optional(),
		type: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginComposerControl>;

export const pluginComputerUsePlannerResponseSchema = z
	.object({
		description: z.string().optional(),
		id: z.string(),
		label: z.string(),
		model_id: z.string(),
		plugin: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginComputerUsePlanner>;

export const pluginContextMenuItemResponseSchema = z
	.object({
		anchor: z.string(),
		args: pluginDocumentSchema.optional(),
		capability: z.string().optional(),
		feedback: z
			.object({
				error: z.string().optional(),
				loading: z.string().optional(),
				success: z.string().optional(),
			})
			.catchall(pluginValueSchema)
			.optional(),
		icon: z.string().optional(),
		id: z.string(),
		label: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginContextMenuItem>;

export const pluginCreateActionResponseSchema = z
	.object({
		args: pluginDocumentSchema.optional(),
		capability: z.string().optional(),
		icon: z.string().optional(),
		id: z.string(),
		label: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		target: z.string().optional(),
		title: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginCreateAction>;

const pluginDockPlacementResponseSchema = z.enum([
	"bottom",
	"right",
	"left",
	"center",
	"both",
]) satisfies z.ZodType<PluginDockPlacement>;

export const pluginDockPanelResponseSchema = z
	.object({
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		panel: z.string(),
		placement: pluginDockPlacementResponseSchema,
		plugin: z.string(),
		spec: pluginValueSchema.optional(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginDockPanel>;

export const pluginFileHandlerResponseSchema = z
	.object({
		companion: z.string(),
		editable: z.boolean(),
		extensions: z.array(z.string()),
		id: z.string(),
		plugin: z.string(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginFileHandler>;

export const pluginHookEventResponseSchema = z
	.object({
		description: z.string().optional(),
		id: z.string(),
		payload_example: pluginDocumentSchema.optional(),
		plugin: z.string().optional(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginHookEvent>;

const contributionHttpPolicyResponseSchema = z.enum([
	"core",
	"owner",
]) satisfies z.ZodType<ContributionHttpPolicy>;

const liveActivityAudioSpecResponseSchema = z
	.object({ loop: z.boolean().optional(), src: z.string() })
	.catchall(pluginValueSchema) satisfies z.ZodType<LiveActivityAudioSpec>;

const liveStatusSchema = z.enum(
	LIVE_ACTIVITY_STATUSES
) satisfies z.ZodType<LiveActivityStatus>;

const liveActivitySourceMapResponseSchema = z
	.object({
		accent: z.string().optional(),
		detail: z.string().optional(),
		icon: z.string().optional(),
		id: z.string().optional(),
		progress: z.string().optional(),
		status: z.string().optional(),
		statusMap: z.record(z.string(), liveStatusSchema).optional(),
		title: z.string().optional(),
		titleFallback: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<LiveActivitySourceMap>;

const liveActivitySpecResponseSchema = z
	.object({
		audio: liveActivityAudioSpecResponseSchema.optional(),
		map: liveActivitySourceMapResponseSchema.optional(),
		source: viewSourceSchema.optional(),
		target: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<LiveActivitySpec>;

const liveActivityContributionResponseSchema = z
	.object({
		accent: z.string().optional(),
		http_policy: contributionHttpPolicyResponseSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		plugin: z.string().optional(),
		spec: liveActivitySpecResponseSchema.optional(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<LiveActivityContribution>;

export const pluginLiveActivityResponseSchema = z.intersection(
	liveActivityContributionResponseSchema.omit({
		spec: true,
		http_policy: true,
	}),
	z
		.object({
			spec: pluginValueSchema.optional(),
			http_policy: pluginValueSchema.optional(),
		})
		.catchall(pluginValueSchema)
) satisfies z.ZodType<PluginLiveActivity>;
