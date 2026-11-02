/**
 * Empty-node answers for the GETs the desktop shell's providers and Layout send
 * while they bootstrap (see shell-proof-providers.tsx). Each spec that mounts the
 * shell lists the paths it expects in its own request ledger and answers only
 * those from here: an unlisted path is still an unexpected request. Shapes follow
 * the production decoders named beside each entry.
 */
import type { PluginValue } from "../../src/lib/api/plugin-wire-values.ts";

export const SHELL_BOOTSTRAP_ROUTES = {
	// usePluginContributions: every contribution list empty.
	"/api/plugins/contributions": {
		agent_edit_panels: [],
		composer_controls: [],
		chat_features: [],
		chat_widget_templates: [],
		settings_tabs: [],
		message_actions: [],
		selection_actions: [],
		output_styles: [],
		context_menu_items: [],
		create_actions: [],
		slash_commands: [],
		turn_hooks: [],
		hook_events: [],
		views: [],
		sidebar_sections: [],
		sidebar_modes: [],
		sidebar_buttons: [],
		themes: [],
		dock_panels: [],
		live_activities: [],
		store_tabs: [],
		channels: [],
		companions: [],
		widget_apps: [],
	},
	// api/meetings.ts: no recorded meetings.
	"/api/meetings": { meetings: [] },
	// api/voice.ts: no installed TTS engines or models.
	"/api/voice/tts-engines": { data: [] },
	"/api/voice/tts-models": { data: [] },
	// api/embeddings.ts: the active embedding model, nothing to reindex.
	"/api/embeddings/model": { dims: 768, model_id: "fixture-embedding" },
	"/api/embeddings/reindex/status": {
		current_model: "fixture-embedding",
		current_dims: 768,
		total_chunks: 0,
		pending_chunks: 0,
		running: false,
	},
	// api/a2a.ts: A2A off; the list endpoints return bare arrays.
	"/api/a2a/settings": {
		description: "",
		displayName: "Shell fixture",
		enabled: false,
		exposeExtendedCard: false,
		maxConcurrentTasks: 1,
		maxPayloadBytes: 1_048_576,
		publicBaseUrl: null,
		tenantId: "fixture",
		updatedAt: "2026-10-04T00:00:00Z",
	},
	"/api/a2a/peers": [],
	"/api/a2a/principals": [],
	"/api/a2a/published-agents": [],
	"/api/a2a/tasks": [],
	// api/billing.ts: the signed-out entitlement snapshot.
	"/api/billing/subscription-status": {
		entitlement: null,
		plan: null,
		subscription: null,
		features: {},
		hostedAgents: null,
		organizationId: null,
		scope: "user",
	},
	// Better Auth: no signed-in session.
	"/api/auth/get-session": null,
} satisfies Record<string, PluginValue>;

export type ShellBootstrapPath = keyof typeof SHELL_BOOTSTRAP_ROUTES;

/** The fixture answer for a path the spec listed, or undefined for any other. */
export function shellBootstrapResponse(
	expected: readonly ShellBootstrapPath[],
	pathname: string
): { json: PluginValue } | undefined {
	const path = expected.find((candidate) => candidate === pathname);
	return path === undefined
		? undefined
		: { json: SHELL_BOOTSTRAP_ROUTES[path] };
}
