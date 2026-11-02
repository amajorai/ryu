// Isolate the component fixture from account setup and the native auth store.
export const TOKEN_KEY = "cloud-proof-account-token";
export const BACKEND_URL = "http://127.0.0.1:5249";
export const FRONTEND_URL = "http://127.0.0.1:5249";
// Billing reads the active account token through this accessor; the proof has
// no account vault, only the token it seeds under TOKEN_KEY.
export function getActiveToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}
// The proof signs in no account, so there is no active account id.
export function getActiveUserId(): string | null {
	return null;
}
