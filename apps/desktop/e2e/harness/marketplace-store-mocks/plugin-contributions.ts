export function usePluginContributions() {
	return {
		agent_edit_panels: [],
		composer_controls: [],
		chat_features: [],
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
	};
}

/** Same route shape as the real hook module, which shared panels import. */
export function pluginCompanionPath(companionId: string): string {
	return `/plugin/${encodeURIComponent(companionId)}`;
}

/** The harness contributions are static, so the query has always settled. */
export function usePluginContributionsQuery() {
	return {
		data: usePluginContributions(),
		error: null,
		isPending: false,
		isSuccess: true,
		status: "success" as const,
	};
}
