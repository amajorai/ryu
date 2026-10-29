const empty = async () => undefined;
const contributions = {
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

export function usePluginContributions() {
	return contributions;
}

export const DEFAULT_CORE_URL = "http://127.0.0.1:5192";
export const AUTH_CORE_URL = DEFAULT_CORE_URL;
export const BACKEND_URL = DEFAULT_CORE_URL;
export const FRONTEND_URL = DEFAULT_CORE_URL;
export const TOKEN_KEY = "ryu_session_token";
export function resolveDefaultCoreUrl() {
	return DEFAULT_CORE_URL;
}
export function getActiveUserId() {
	return "library-engine-fixture-user";
}
export function useSession() {
	return {
		data: {
			user: {
				id: getActiveUserId(),
				name: "Library Fixture",
				email: "library@example.test",
			},
		},
		isPending: false,
	};
}
export function useActiveNode() {
	return {
		name: "Library engine fixture",
		token: "fixture-node-token",
		url: window.location.origin,
		userJwt: null,
	};
}
export function useActiveNodeGetter() {
	return useActiveNode;
}
export function usePluginSettingsOpener() {
	return () => null;
}
export function useEntitlementContext() {
	return {
		canUse: () => true,
		ready: true,
		refresh: empty,
		requestUpgrade: () => undefined,
		verdict: {
			daysLeftInTrial: 0,
			managedInference: false,
			marketplaceApps: true,
			paywalled: false,
			plan: "pro",
			proUnlocked: true,
			reason: "subscription",
		},
	};
}
const tabsState = {
	activateTab: () => undefined,
	openTab: (path: string) => {
		window.dispatchEvent(
			new CustomEvent("library-engine:tab", { detail: path })
		);
	},
	tabs: [],
};
const spaces = { spaces: [], loading: false, create: empty, remove: empty };
const history = {
	conversations: [],
	conversationsLoading: false,
	deleteConversation: empty,
	renameConversation: empty,
};

export function useTabSelector<T>(selector: (state: typeof tabsState) => T): T {
	return selector(tabsState);
}

export const useTabStore = useTabSelector;

export function useTabsContext() {
	return tabsState;
}

export function useCurrentTabId() {
	return undefined;
}

export function useSpacesContext() {
	return spaces;
}

export function useChatHistoryContext() {
	return history;
}

export function usePluginContributionsQuery() {
	return { data: usePluginContributions(), isLoading: false };
}

export function pluginCompanionPath(id: string) {
	return `/plugins/${id}`;
}

export function pluginViewPath(pluginId: string, viewId: string) {
	return `/plugins/${pluginId}/views/${viewId}`;
}

export function pluginDockPanelKey(pluginId: string, panelId: string) {
	return `${pluginId}:${panelId}`;
}
