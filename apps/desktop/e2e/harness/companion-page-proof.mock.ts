import { useEffect, useState } from "react";
export const TOKEN_KEY = "companion-proof-session";
export const BACKEND_URL = location.origin;
export const FRONTEND_URL = "https://ryuhq.com";
export const DEFAULT_CORE_URL = location.origin;
export function useActiveNode() {
	const [token, setToken] = useState("companion-node-token");
	useEffect(() => {
		const update = (event: Event) =>
			setToken(
				/* SAFETY: companion-page-proof.spec.ts dispatches the private companion-node CustomEvent with the authored second-node-token string; this listener changes that controlled fixture token only. */ (
					event as CustomEvent<string>
				).detail
			);
		window.addEventListener("companion-node", update);
		return () => window.removeEventListener("companion-node", update);
	}, []);
	return { url: location.origin, token, userJwt: null };
}
export function useEntitlement() {
	return {
		ready: true,
		canUse: () => !new URLSearchParams(location.search).has("free"),
	};
}
export async function openExternal(url: string) {
	const values = JSON.parse(localStorage.getItem("companion-external") ?? "[]");
	values.push(url);
	localStorage.setItem("companion-external", JSON.stringify(values));
}
export async function load() {
	return {
		get: async (key: string) =>
			JSON.parse(localStorage.getItem("companion-store") ?? "{}")[key],
		set: async <Value>(key: string, value: Value) => {
			const state = JSON.parse(localStorage.getItem("companion-store") ?? "{}");
			state[key] = value;
			localStorage.setItem("companion-store", JSON.stringify(state));
		},
		save: async () => {},
	};
}
export function isDevMetricsEnabled() {
	return false;
}
export function recordHttpSample() {}
export function normalizePath(path: string) {
	return path;
}
export function track() {}

export const AUTH_CORE_URL = location.origin;
export function useActiveNodeGetter() {
	return () => ({
		url: location.origin,
		token: "companion-node-token",
		userJwt: null,
	});
}
