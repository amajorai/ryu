export function pluginCompanionPath(companionId: string): string {
	return `/plugins/${companionId}`;
}

export function pluginViewPath(pluginId: string, viewId: string): string {
	return `/plugin-view/${pluginId}/${viewId}`;
}

export function pluginDockPanelKey(pluginId: string, panelId: string): string {
	return `plugin:${pluginId}:${panelId}`;
}

export const DECLARATIVE_VIEW_HARNESS_PATH = "/dev/declarative-view";

const EMPTY_CONTRIBUTIONS = {
	agent_edit_panels: [],
	channels: [],
	chat_features: [],
	companions: [],
	composer_controls: [],
	context_menu_items: [],
	create_actions: [],
	dock_panels: [],
	hook_events: [],
	live_activities: [],
	message_actions: [],
	selection_actions: [],
	settings_tabs: [],
	sidebar_buttons: [],
	sidebar_modes: [],
	sidebar_sections: [],
	slash_commands: [],
	store_tabs: [],
	themes: [],
	turn_hooks: [],
	views: [],
	widget_apps: [],
};

export function usePluginContributions() {
	return EMPTY_CONTRIBUTIONS;
}

export function usePluginContributionsQuery() {
	return {
		data: EMPTY_CONTRIBUTIONS,
		isFetching: false,
		isLoading: false,
		isSuccess: true,
	};
}

export function usePluginContributionsLiveRefresh(): void {
	// The fixture has no live Core contribution stream.
}

export function usePluginContributionRoutes(): void {
	// The fixture intentionally registers no contributed routes.
}

export function usePluginContributionTabIcons(): void {
	// The fixture intentionally registers no contributed icons.
}
