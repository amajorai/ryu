// Installs the proof's Tauri bridge before any app module evaluates.
//
// Tauri injects `__TAURI_INTERNALS__` before page scripts run, and
// lib/auth-client.ts reads its sealed auth-vault slot as soon as it is imported
// (already so at 07d403e33, before Ryu Quiet). A bridge the harness installed
// after that first read left the vault locked, so the denied member's session
// never reached the workspace permission check. This side-effect module is the
// harness's first import.

const denied =
	new URLSearchParams(window.location.search).get("permission") === "denied";

/** The denied member's session, served as the sealed auth vault's one account. */
const DENIED_VAULT = JSON.stringify({
	accounts: [
		{
			email: "fallback-proof@example.test",
			image: null,
			name: "Fallback proof member",
			token: "fallback-rules-proof-session",
			userId: "fallback-proof-user",
		},
	],
	activeUserId: "fallback-proof-user",
});

function invoke(
	command: string,
	args?: { name?: unknown }
): Promise<string | undefined> {
	// Every other command keeps the unanswered fallback.
	return Promise.resolve(
		denied && command === "desktop_secret_get" && args?.name === "auth-vault"
			? DENIED_VAULT
			: undefined
	);
}

Object.assign(window, {
	__TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
});
