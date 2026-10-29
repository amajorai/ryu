// Local proof boundaries only; the production HTTP helpers remain unchanged.
export const TOKEN_KEY = "sdk-quota-proof-token";
export function useActiveNode() {
	return { url: window.location.origin, token: null, userJwt: null };
}
export function isDevMetricsEnabled() {
	return false;
}
export function normalizePath(value: string) {
	return value;
}
export function recordHttpSample() {}
export function getRealtimeJwt() {
	return null;
}
