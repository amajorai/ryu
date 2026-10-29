export function useActiveNode() {
	return {
		token: "ugc-panel-proof-node-token",
		url: "http://127.0.0.1:7980",
		userJwt: null,
	};
}

export function useApps() {
	return {
		apps: [
			{
				enabled:
					new URLSearchParams(window.location.search).get("disabled") !== "1",
				id: "@ryu/ugc",
			},
		],
		clearToggleError: () => undefined,
		error: null,
		install: async () => ({ id: "@ryu/ugc" }),
		loading: false,
		reload: async () => undefined,
		toggle: async () => ({ success: true as const }),
		toggleError: null,
		uninstall: async () => undefined,
	};
}
