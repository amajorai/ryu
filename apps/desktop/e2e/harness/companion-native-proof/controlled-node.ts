// Only compute identity, entitlement and HTTP origin are controlled. Store and
// Tauri window/event modules retain their installed production implementations.
export const DEFAULT_CORE_URL = location.origin;
export const AUTH_CORE_URL = location.origin;
export const TOKEN_KEY = "companion-native-proof-session";
export const BACKEND_URL = location.origin;
export const FRONTEND_URL = "https://ryuhq.com";
export function useActiveNode() {
	return {
		url: location.origin,
		token: "companion-native-proof-token",
		userJwt: null,
	};
}
export function useActiveNodeGetter() {
	return useActiveNode;
}
export function useEntitlement() {
	return { ready: true, canUse: () => true };
}
