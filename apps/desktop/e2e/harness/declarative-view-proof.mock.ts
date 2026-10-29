import type { ViewSpec } from "@ryu/app-host/views";
import { useEffect, useState } from "react";
import blueprint from "../../../../apps-store/blueprint/manifest.json" with {
	type: "json",
};
export const TOKEN_KEY = "declarative-proof-session";
export const BACKEND_URL = window.location.origin;
function useScope() {
	const [scope, setScope] = useState({
		token: "declarative-node-token",
		denied: new URLSearchParams(location.search).has("deny"),
	});
	useEffect(() => {
		const update = (event: Event) =>
			setScope(
				/* SAFETY: declarative-view-proof.spec.ts dispatches this private declarative-scope CustomEvent with the authored string token and boolean denied fields. This controlled listener view is not a validator for foreign events. */ (
					event as CustomEvent<typeof scope>
				).detail
			);
		window.addEventListener("declarative-scope", update);
		return () => window.removeEventListener("declarative-scope", update);
	}, []);
	return scope;
}
export function useActiveNode() {
	const scope = useScope();
	return { url: window.location.origin, token: scope.token, userJwt: null };
}
const custom: ViewSpec = {
	view: "form",
	fields: [
		{
			id: "name",
			label: "Name",
			type: "text",
			required: true,
			value: "Initial",
		},
		{ id: "notes", label: "Notes", type: "textarea", value: "Initial note" },
		{ id: "count", label: "Count", type: "number", value: 0 },
		{ id: "enabled", label: "Enabled", type: "switch", value: false },
		{
			id: "mode",
			label: "Mode",
			type: "select",
			options: [
				{ value: "fast", label: "Fast" },
				{ value: "safe", label: "Safe" },
			],
		},
	],
	submit: {
		id: "save",
		label: "Save",
		http: {
			method: "POST",
			path: "/api/ext/com.example.author/items",
			body: {
				name: "{{name}}",
				notes: "{{notes}}",
				count: "{{count}}",
				enabled: "{{enabled}}",
				mode: "{{mode}}",
			},
		},
	},
	actions: [{ id: "preview", label: "Preview", intent: "preview" }],
};
export function usePluginContributions() {
	const params = new URLSearchParams(location.search);
	const denied = useScope().denied;
	const grants = denied ? [] : ["ui:declarative-http"];
	if (params.has("custom")) {
		return {
			views: [
				{
					id: "author-form",
					title: "Author contribution",
					plugin: "com.example.author",
					http_policy: "owner",
					approved_grants: grants,
					spec:
						params.get("custom") === "list"
							? {
									view: "list-detail",
									items: [
										{ id: "first", title: "First record" },
										{ id: "second", title: "Second record" },
									],
									actions: [
										{
											id: "inspect",
											label: "Inspect selected",
											intent: "inspect",
										},
									],
								}
							: custom,
				},
			],
		};
	}
	return {
		views: blueprint.contributes.views.map((view) => ({
			...view,
			plugin: "com.ryu.blueprint",
			http_policy: "core",
			approved_grants: grants,
		})),
	};
}
export function useTabSelector() {
	return (path: string) => {
		location.href = path;
	};
}
export function isDevMetricsEnabled() {
	return false;
}
export function recordHttpSample() {}
export function normalizePath(path: string) {
	return path;
}
