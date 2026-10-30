import { z } from "zod";
import { sealedLocalStorage } from "../content-seal.ts";

/** localStorage key for this install's stable, randomly-generated client id. */
const CLIENT_ID_KEY = "ryu_client_id";
/** localStorage key the app store persists the signed-in OIDC user under. */
const OIDC_USER_KEY = "ryu_oidc_user";

const presenceUserSchema = z.object({
	name: z.string().optional().catch(undefined),
	email: z.string().optional().catch(undefined),
});

/** Stable per-install id, generated once and persisted. Used to dedup presence. */
function clientId(): string {
	try {
		let id = localStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id =
				globalThis.crypto?.randomUUID === undefined
					? `desktop-${Date.now()}-${Math.round(Math.random() * 1e9)}`
					: crypto.randomUUID();
			localStorage.setItem(CLIENT_ID_KEY, id);
		}
		return id;
	} catch {
		return "desktop-unknown";
	}
}

/** This install's stable client id (the value sent as `X-Ryu-Client-Id`). */
export function currentClientId(): string {
	return clientId();
}

/**
 * Self-declared presence identity headers, sent on every Core request so the
 * node's connections registry can show "who is connected" (see
 * apps/core/src/connections). This is ATTRIBUTION, not authentication: the node
 * token in `Authorization` is the real trust boundary; these are display labels
 * a node operator can see. User fields are URL-encoded so a non-ASCII display
 * name is still a valid HTTP header value (Core percent-decodes them).
 */
export function identityHeaders() {
	const headers: RequestInit["headers"] = {
		"X-Ryu-Client-Id": clientId(),
		"X-Ryu-Client-Label": "Desktop",
		"X-Ryu-Surface": "desktop",
	};
	try {
		const raw = sealedLocalStorage.getItem(OIDC_USER_KEY);
		if (raw) {
			const user = presenceUserSchema.parse(JSON.parse(raw));
			if (user.email) {
				headers["X-Ryu-User-Id"] = encodeURIComponent(user.email);
			}
			if (user.name) {
				headers["X-Ryu-User-Name"] = encodeURIComponent(user.name);
			}
		}
	} catch {
		// Not signed in / no storage — presence still works, just shows as anonymous.
	}
	return headers;
}
