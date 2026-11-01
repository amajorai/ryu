// The proof uses the production Desktop Core request clients but runs outside
// the Next.js app. Those clients import only the auth constants and the
// bearer reader below; session/JWT behavior is supplied explicitly by the
// local proof host target.
export const BACKEND_URL = "http://127.0.0.1:5291";
export const TOKEN_KEY = "ryu_session_token";

/** The harness keeps no local account vault, so there is no bearer token. */
export function getActiveToken(): string | null {
	return null;
}
