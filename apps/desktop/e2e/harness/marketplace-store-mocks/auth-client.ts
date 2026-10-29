export const BACKEND_URL = "http://127.0.0.1:5189";
export const FRONTEND_URL = "http://127.0.0.1:5189";
export const TOKEN_KEY = "ryu_session_token";

export function getActiveUserId() {
	return "marketplace-store-fixture-user";
}

/** The harness keeps no local account vault or bearer token. */
export function listAccounts() {
	return [];
}

export function getActiveToken() {
	return null;
}

export function useSession() {
	return {
		data: {
			user: {
				email: "store-fixture@example.test",
				id: "marketplace-store-fixture-user",
				name: "Marketplace Store Fixture",
			},
		},
		isPending: false,
	};
}
