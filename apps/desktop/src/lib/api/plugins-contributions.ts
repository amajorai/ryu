import { parseAvatarContributions } from "@ryu/ui/components/avatar-parts.ts";
import { parseInterfaceContributions } from "@ryuhq/protocol/interfaces";
import { z } from "zod";
import {
	type ApiTarget,
	authenticatedFetch,
	identityHeaders,
	makeHeaders,
} from "./client.ts";
import {
	hasControlCharacters,
	isValidPluginId,
	parsePluginBackgrounds,
} from "./plugin-contribution-boundary.ts";
import { pluginValueSchema } from "./plugin-wire-values.ts";
import { parsePluginResponse } from "./plugins-app-response-contracts.ts";
import { uiBundleSchema } from "./plugins-catalog-response-contracts.ts";
import { pluginContributionsWireSchema } from "./plugins-contribution-response-contracts.ts";
import { toPluginCompanion } from "./plugins-contribution-surface-types.ts";
import type {
	PluginComputerUsePlanner,
	PluginContributions,
} from "./plugins-contribution-types.ts";

const plannerTextSchema = z
	.string()
	.refine((value) => !hasControlCharacters(value));
const pluginComputerUsePlannerSchema = z
	.object({
		description: plannerTextSchema.max(512).optional(),
		id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
		label: plannerTextSchema
			.max(128)
			.refine((value) => value.trim().length > 0),
		model_id: plannerTextSchema
			.max(256)
			.refine((value) => value.trim().length > 0),
		plugin: z.string().refine(isValidPluginId),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginComputerUsePlanner>;
function isPluginComputerUsePlanner(
	value: Parameters<typeof pluginComputerUsePlannerSchema.parse>[0]
): value is PluginComputerUsePlanner {
	return pluginComputerUsePlannerSchema.safeParse(value).success;
}

export function parsePluginComputerUsePlanners(
	value: Parameters<typeof pluginComputerUsePlannerSchema.parse>[0]
): PluginComputerUsePlanner[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const planners: PluginComputerUsePlanner[] = [];
	for (const entry of value) {
		if (!isPluginComputerUsePlanner(entry)) {
			continue;
		}
		const key = `${entry.plugin}\u001f${entry.id}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		planners.push(entry);
	}
	return planners;
}

export async function getPluginContributions(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<PluginContributions> {
	const resp = await authenticatedFetch(target, "/api/plugins/contributions", {
		method: "GET",
		signal,
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...identityHeaders(),
		},
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins/contributions failed: ${resp.status}`);
	}
	const json = parsePluginResponse(
		pluginContributionsWireSchema,
		await resp.json()
	);
	const computerUsePlanners = parsePluginComputerUsePlanners(
		json.computer_use_planners
	);
	const backgrounds = parsePluginBackgrounds(json.backgrounds);
	const avatars = parseAvatarContributions(
		json.avatar_accessories,
		json.avatar_styles
	);
	const interfaces = parseInterfaceContributions(json.interfaces);
	return {
		agent_edit_panels: json.agent_edit_panels ?? [],
		agent_profile_tabs: json.agent_profile_tabs ?? [],
		avatar_accessories: avatars.accessories,
		avatar_styles: avatars.styles,
		composer_controls: json.composer_controls ?? [],
		chat_features: json.chat_features ?? [],
		computer_use_planners: computerUsePlanners,
		chat_widget_templates: json.chat_widget_templates ?? [],
		settings_tabs: json.settings_tabs ?? [],
		message_actions: json.message_actions ?? [],
		selection_actions: json.selection_actions ?? [],
		output_styles: json.output_styles ?? [],
		context_menu_items: json.context_menu_items ?? [],
		create_actions: json.create_actions ?? [],
		slash_commands: json.slash_commands ?? [],
		turn_hooks: json.turn_hooks ?? [],
		hook_events: json.hook_events ?? [],
		views: json.views ?? [],
		sidebar_sections: json.sidebar_sections ?? [],
		sidebar_modes: json.sidebar_modes ?? [],
		sidebar_buttons: json.sidebar_buttons ?? [],
		themes: json.themes ?? [],
		backgrounds,
		interfaces,
		dock_panels: json.dock_panels ?? [],
		file_handlers: json.fileHandlers ?? json.file_handlers ?? [],
		live_activities: json.live_activities ?? [],
		store_tabs: json.store_tabs ?? [],
		channels: json.channels ?? [],
		companions: (json.companions ?? []).map(toPluginCompanion),
		// `widget_apps` is declared non-optional on PluginContributions but was never
		// carried across this boundary, so every reader saw `undefined` behind an
		// array type. Defaulted here for the same reason as its siblings.
		widget_apps: json.widget_apps ?? [],
	};
}

/**
 * `GET /api/plugins/:id/ui-bundle` — fetch the bundled UI code of an ENABLED
 * plugin over the TRUSTED Core API (the host holds the node token; the plugin
 * never does). Returns the module source string, or `null` when the plugin has
 * no bundle / is not enabled (Core answers 404). The host base64-encodes this
 * into the sandboxed `srcdoc`; it is NEVER handed to the plugin frame directly.
 */
export async function fetchPluginUiBundle(
	target: ApiTarget,
	id: string,
	signal?: AbortSignal
): Promise<string | null> {
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodeURIComponent(id)}/ui-bundle`,
		{
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
	if (resp.status === 404) {
		return null;
	}
	if (!resp.ok) {
		throw new Error(`/api/plugins/${id}/ui-bundle failed: ${resp.status}`);
	}
	const json = parsePluginResponse(uiBundleSchema, await resp.json());
	return json.code ?? null;
}
