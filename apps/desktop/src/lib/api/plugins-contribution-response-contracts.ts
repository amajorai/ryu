// Plugin contribution response schemas (message actions through the full
// contributions envelope) that `plugins.ts` reads. Split out of `plugins.ts`;
// the public client API stays there.

import {
	rawViewContributionSchema,
	viewSourceSchema,
} from "@ryu/app-host/views";
import {
	avatarAccessorySchema,
	avatarStyleSchema,
} from "@ryu/ui/components/avatar-parts.ts";
import {
	type InterfaceDescriptor,
	parseInterfaceContribution,
} from "@ryuhq/protocol/interfaces";
import { z } from "zod";
import { pluginBackgroundSchema } from "./plugin-contribution-boundary.ts";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "./plugin-wire-values.ts";
import type {
	PluginCompanionWire,
	PluginContributions,
	PluginMessageAction,
	PluginOutputStyle,
	PluginSelectionAction,
	PluginSidebarButton,
	PluginSidebarMode,
	PluginSidebarSection,
	PluginStoreTab,
	PluginTheme,
	PluginView,
	PluginWidgetApp,
} from "./plugins.ts";
import {
	pluginAgentEditPanelResponseSchema,
	pluginAgentProfileTabResponseSchema,
	pluginChannelResponseSchema,
	pluginChatFeatureResponseSchema,
	pluginChatWidgetTemplateResponseSchema,
	pluginCompanionResponseSchema,
	pluginComposerControlResponseSchema,
	pluginComputerUsePlannerResponseSchema,
	pluginContextMenuItemResponseSchema,
	pluginCreateActionResponseSchema,
	pluginDockPanelResponseSchema,
	pluginFileHandlerResponseSchema,
	pluginHookEventResponseSchema,
	pluginLiveActivityResponseSchema,
} from "./plugins-contribution-item-contracts.ts";

const pluginMessageActionResponseSchema = z
	.object({
		args: pluginDocumentSchema.optional(),
		capability: z.string().optional(),
		http_policy: pluginValueSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		kind: z.string(),
		label: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		state_source: viewSourceSchema.optional(),
		states: z
			.array(
				z
					.object({
						active_icon: z.string().optional(),
						icon: z.string().optional(),
						label: z.string(),
						value: z.string(),
					})
					.catchall(pluginValueSchema)
			)
			.optional(),
		target: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginMessageAction>;

const pluginOutputStyleResponseSchema = z
	.object({
		description: z.union([z.string(), z.null()]),
		force_for_plugin: z.boolean(),
		id: z.string(),
		keep_coding_instructions: z.boolean(),
		name: z.string(),
		plugin: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginOutputStyle>;

const pluginSelectionActionResponseSchema = z
	.object({
		args: pluginDocumentSchema.optional(),
		capability: z.string().optional(),
		icon: z.string().optional(),
		id: z.string(),
		kind: z.string(),
		label: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginSelectionAction>;

const pluginSidebarButtonResponseSchema = z
	.object({
		context: pluginDocumentSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		target: z.string(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginSidebarButton>;

const pluginSidebarModeResponseSchema = z
	.object({
		default_section: z.string().optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		sections: z.array(z.string()),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginSidebarMode>;

const pluginSidebarSectionResponseSchema = z
	.object({
		approved_grants: z.array(z.string()).optional(),
		http_policy: pluginValueSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		spec: pluginValueSchema.optional(),
		title: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginSidebarSection>;

const pluginStoreTabResponseSchema = z
	.object({
		app_enabled: z.boolean(),
		app_installed: z.boolean(),
		group: z.string().optional(),
		http_policy: pluginValueSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		order: z.number().optional(),
		plugin: z.string(),
		spec: pluginValueSchema.optional(),
		subtitle: z.string().optional(),
		title: z.string(),
		view: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginStoreTab>;

const pluginThemeTokenFieldsSchema = z.record(z.string(), z.string());

// Record parsers omit an own __proto__ key. Check every native token value and
// preserve the original map so future CSS keys survive at the theme boundary.
const pluginThemeTokensSchema = z.custom<
	z.output<typeof pluginThemeTokenFieldsSchema>
>(
	(value) =>
		pluginThemeTokenFieldsSchema.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(token) => z.string().safeParse(token).success
		)
);

export const pluginThemeResponseSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		mode: z.enum(["light", "dark"]),
		plugin: z.string(),
		preview: z
			.object({
				bg: z.string(),
				surface: z.string(),
				primary: z.string(),
				text: z.string(),
			})
			.catchall(pluginValueSchema),
		tokens: pluginThemeTokensSchema,
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginTheme>;

const pluginViewResponseSchema =
	rawViewContributionSchema satisfies z.ZodType<PluginView>;

const pluginWidgetAppResponseSchema = z
	.object({
		granted: z.boolean(),
		name: z.string(),
		plugin_id: z.string(),
		widget_count: z.number(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginWidgetApp>;

/** A validated Marketplace interface. Parsing a descriptor again is idempotent,
 *  so the same predicate guards served rows and already-parsed values. */
const pluginInterfaceSchema = z.custom<InterfaceDescriptor>(
	(value) => parseInterfaceContribution(value) !== null
);

const pluginContributionsResponseSchema = z
	.object({
		agent_edit_panels: z.array(pluginAgentEditPanelResponseSchema),
		agent_profile_tabs: z.array(pluginAgentProfileTabResponseSchema).optional(),
		avatar_accessories: z.array(avatarAccessorySchema),
		avatar_styles: z.array(avatarStyleSchema),
		backgrounds: z.array(pluginBackgroundSchema),
		channels: z.array(pluginChannelResponseSchema),
		chat_features: z.array(pluginChatFeatureResponseSchema),
		chat_widget_templates: z
			.array(pluginChatWidgetTemplateResponseSchema)
			.optional(),
		companions: z.array(pluginCompanionResponseSchema),
		composer_controls: z.array(pluginComposerControlResponseSchema),
		computer_use_planners: z.array(pluginComputerUsePlannerResponseSchema),
		context_menu_items: z.array(pluginContextMenuItemResponseSchema),
		create_actions: z.array(pluginCreateActionResponseSchema),
		dock_panels: z.array(pluginDockPanelResponseSchema),
		file_handlers: z.array(pluginFileHandlerResponseSchema).optional(),
		hook_events: z.array(pluginHookEventResponseSchema),
		interfaces: z.array(pluginInterfaceSchema),
		live_activities: z.array(pluginLiveActivityResponseSchema),
		message_actions: z.array(pluginMessageActionResponseSchema),
		output_styles: z.array(pluginOutputStyleResponseSchema),
		selection_actions: z.array(pluginSelectionActionResponseSchema),
		settings_tabs: z.array(pluginDocumentSchema),
		sidebar_buttons: z.array(pluginSidebarButtonResponseSchema),
		sidebar_modes: z.array(pluginSidebarModeResponseSchema),
		sidebar_sections: z.array(pluginSidebarSectionResponseSchema),
		slash_commands: z.array(pluginDocumentSchema),
		store_tabs: z.array(pluginStoreTabResponseSchema),
		themes: z.array(pluginThemeResponseSchema),
		turn_hooks: z.array(pluginDocumentSchema),
		views: z.array(pluginViewResponseSchema),
		widget_apps: z.array(pluginWidgetAppResponseSchema),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginContributions>;

const pluginCompanionWireResponseSchema = z
	.object({
		approved_grants: z.array(z.string()).optional(),
		csp: z
			.union([
				z
					.object({
						connect_domains: z.array(z.string()).optional(),
						resource_domains: z.array(z.string()).optional(),
					})
					.catchall(pluginValueSchema),
				z.null(),
			])
			.optional(),
		default_csp_enforced: z.boolean().optional(),
		first_party: z.boolean().optional(),
		has_ui: z.boolean().optional(),
		icon: z.string().optional(),
		id: z.string(),
		label: z.string(),
		mcpToolId: z.string().optional(),
		name: z.string(),
		navigationVisible: z.boolean().optional(),
		plugin_id: z.string().optional(),
		shortcut: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginCompanionWire>;

export const pluginContributionsWireSchema = pluginContributionsResponseSchema
	.partial()
	.omit({
		avatar_accessories: true,
		avatar_styles: true,
		companions: true,
		backgrounds: true,
		computer_use_planners: true,
		interfaces: true,
	})
	.extend({
		avatar_accessories: pluginValueSchema.optional(),
		avatar_styles: pluginValueSchema.optional(),
		companions: z.array(pluginCompanionWireResponseSchema).optional(),
		backgrounds: pluginValueSchema.optional(),
		interfaces: pluginValueSchema.optional(),
		computer_use_planners: pluginValueSchema.optional(),
		fileHandlers: z.array(pluginFileHandlerResponseSchema).optional(),
	});
