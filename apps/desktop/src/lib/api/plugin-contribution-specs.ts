import {
	LIVE_ACTIVITY_STATUSES,
	type LiveActivityAudioSpec,
	type LiveActivityContribution,
	type LiveActivitySourceMap,
	type LiveActivitySpec,
} from "@ryu/app-host/live-activity";
import {
	type DockPanelSpec,
	LIBRARY_VIEW_KINDS,
	type SidebarSectionCreate,
	type SidebarSectionSpec,
	type StoreDetailGraphSpec,
	type StoreDetailSpec,
	type StoreInstallSpec,
	type StoreItemMap,
	type StoreTabSpec,
	VIEW_ACTION_HTTP_METHODS,
	type ViewAction,
	type ViewActionHttp,
	type ViewActionStyle,
	type ViewTextTransform,
	viewSourceSchema,
} from "@ryu/app-host/views";
import { z } from "zod";
import { type PluginValue, pluginValueSchema } from "./plugin-wire-values.ts";
import type {
	PluginDockPanel,
	PluginLiveActivity,
	PluginSidebarSection,
	PluginStoreTab,
} from "./plugins.ts";

const viewActionMethodSchema = z.enum(VIEW_ACTION_HTTP_METHODS);
const libraryViewKindSchema = z.enum(LIBRARY_VIEW_KINDS);
const liveStatusSchema = z.enum(LIVE_ACTIVITY_STATUSES);
const viewActionHttpSchema = z
	.object({
		body: pluginValueSchema.optional(),
		method: viewActionMethodSchema,
		path: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<ViewActionHttp>;

const sidebarSectionCreateSchema = z.union([
	z
		.object({
			http: viewActionHttpSchema,
			icon: z.string().optional(),
			label: z.string().optional(),
			target: z.never().optional(),
			targetFrom: z.string().optional(),
		})
		.catchall(pluginValueSchema),
	z
		.object({
			target: z.string(),
			icon: z.string().optional(),
			label: z.string().optional(),
			http: z.never().optional(),
			targetFrom: z.never().optional(),
		})
		.catchall(pluginValueSchema),
]) satisfies z.ZodType<SidebarSectionCreate>;

const viewActionStyleSchema = z.enum([
	"primary",
	"default",
	"danger",
]) satisfies z.ZodType<ViewActionStyle>;

const viewActionSchema = z
	.object({
		confirm: z.string().optional(),
		http: viewActionHttpSchema.optional(),
		icon: z.string().optional(),
		id: z.string(),
		intent: z.string().optional(),
		label: z.string(),
		payload: pluginValueSchema.optional(),
		style: viewActionStyleSchema.optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<ViewAction>;

export const sidebarSectionSpecSchema = z
	.object({
		context: z.record(z.string(), z.string()).optional(),
		create: sidebarSectionCreateSchema.optional(),
		dateKey: z.string().optional(),
		emptyState: z
			.object({
				description: z.string().optional(),
				title: z.string(),
				unavailable: z.string().optional(),
			})
			.catchall(pluginValueSchema)
			.optional(),
		entity: z
			.object({ anchor: z.string(), idKey: z.string() })
			.catchall(pluginValueSchema)
			.optional(),
		itemActions: z.array(viewActionSchema).optional(),
		itemPreview: z
			.object({
				description: z.string().optional(),
				meta: z
					.array(
						z
							.object({ label: z.string(), value: z.string() })
							.catchall(pluginValueSchema)
					)
					.optional(),
				title: z.string().optional(),
			})
			.catchall(pluginValueSchema)
			.optional(),
		itemTarget: z.string().optional(),
		rowStyle: z.enum(["compact", "messaging"]).optional(),
		source: viewSourceSchema.optional(),
		view: z.union([libraryViewKindSchema, z.string()]).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<SidebarSectionSpec>;

const storeDetailGraphSpecSchema = z
	.object({
		edgeLabel: z.string().optional(),
		edgeSource: z.string().optional(),
		edges: z.string().optional(),
		edgeTarget: z.string().optional(),
		nodeId: z.string().optional(),
		nodeLabel: z.string().optional(),
		nodes: z.string().optional(),
		title: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<StoreDetailGraphSpec>;

const storeDetailSpecSchema = z
	.object({
		graph: storeDetailGraphSpecSchema.optional(),
		item: z.string().optional(),
		source: z
			.object({ http: viewActionHttpSchema })
			.catchall(pluginValueSchema)
			.optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<StoreDetailSpec>;

const storeInstallSpecSchema = z
	.object({
		http: viewActionHttpSchema,
		label: z.string().optional(),
		openTarget: z.string().optional(),
		successMessage: z.string().optional(),
		targetFrom: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<StoreInstallSpec>;

const viewTextTransformSchema = z.enum([
	"basename",
	"humanize",
]) satisfies z.ZodType<ViewTextTransform>;

const storeItemMapSchema = z
	.object({
		badge: z.string().optional(),
		badgeTransform: viewTextTransformSchema.optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
		id: z.string().optional(),
		installed: z.string().optional(),
		sourceUrl: z.string().optional(),
		tags: z.string().optional(),
		title: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<StoreItemMap>;

export const storeTabSpecSchema = z
	.object({
		detail: storeDetailSpecSchema.optional(),
		empty: z
			.object({
				description: z.string().optional(),
				title: z.string().optional(),
			})
			.catchall(pluginValueSchema)
			.optional(),
		groupBy: z.string().optional(),
		groups: z
			.array(
				z
					.object({ label: z.string(), value: z.string() })
					.catchall(pluginValueSchema)
			)
			.optional(),
		install: storeInstallSpecSchema.optional(),
		itemActions: z.array(viewActionSchema).optional(),
		map: storeItemMapSchema.optional(),
		searchFields: z.array(z.string()).optional(),
		searchPlaceholder: z.string().optional(),
		source: viewSourceSchema.optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<StoreTabSpec>;

export const dockPanelSpecSchema = z
	.object({
		companion: z.string().optional(),
		emptyText: z.string().optional(),
		linkHandler: z
			.object({
				bodyKey: z.string().optional(),
				method: z.enum(["POST", "PUT"]).optional(),
				path: z.string(),
				schemes: z.array(z.string()),
			})
			.catchall(pluginValueSchema)
			.optional(),
		view: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<DockPanelSpec>;

const liveActivityAudioSpecSchema = z
	.object({ loop: z.boolean().optional(), src: z.string() })
	.catchall(pluginValueSchema) satisfies z.ZodType<LiveActivityAudioSpec>;

const liveActivitySourceMapSchema = z
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

export const liveActivitySpecSchema = z
	.object({
		audio: liveActivityAudioSpecSchema.optional(),
		map: liveActivitySourceMapSchema.optional(),
		source: viewSourceSchema.optional(),
		target: z.string().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<LiveActivitySpec>;

/** Raw transport specs stay intact; each host interprets only its complete DSL. */
function optionalSpec<S extends z.ZodType>(
	schema: S,
	value: PluginValue | undefined
): z.output<S> | undefined {
	const parsed = z
		.custom<z.output<S>>(
			(candidate) =>
				pluginValueSchema.safeParse(candidate).success &&
				schema.safeParse(candidate).success
		)
		.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}
export function pluginSidebarSpec(section: Pick<PluginSidebarSection, "spec">) {
	return optionalSpec(sidebarSectionSpecSchema, section.spec);
}
export function pluginStoreSpec(tab: Pick<PluginStoreTab, "spec">) {
	return optionalSpec(storeTabSpecSchema, tab.spec);
}
export function pluginDockSpec(panel: Pick<PluginDockPanel, "spec">) {
	return optionalSpec(dockPanelSpecSchema, panel.spec);
}
export function pluginLiveSpec(activity: Pick<PluginLiveActivity, "spec">) {
	return optionalSpec(liveActivitySpecSchema, activity.spec);
}
const httpPolicySchema = z.enum(["core", "owner"]);
export function pluginLiveActivity(
	activity: PluginLiveActivity
): LiveActivityContribution {
	const policy = httpPolicySchema.safeParse(activity.http_policy);
	return {
		...activity,
		http_policy: policy.success ? policy.data : undefined,
		spec: pluginLiveSpec(activity),
	};
}
