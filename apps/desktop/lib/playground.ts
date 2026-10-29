// Build-time switch for the GitHub Codespaces playground webapp bundle.
//
// `apps/webapp` builds the playground with `vite build --mode playground`, which
// reads `apps/webapp/.env.playground` (VITE_PLAYGROUND=1). No other build sets
// the variable, so the desktop app, the hosted webapp, and the Telegram host
// all evaluate `PLAYGROUND_BUILD` to `false` and keep their normal behavior.
//
// In the playground the page is served by a same-origin proxy inside the
// codespace that forwards `/api` to the codespace's own Core and adds Core's
// token server-side. So the bundle talks to its own origin and opens without a
// hosted Ryu account: the visitor is the single local owner of that Core.

/** True only for an environment that explicitly opts in with `VITE_PLAYGROUND=1`. */
export function isPlaygroundEnv(env: object): boolean {
	// `object` accepts every bundler's `ImportMetaEnv` (Vite, WXT), whose declared keys differ.
	return (env as { VITE_PLAYGROUND?: unknown }).VITE_PLAYGROUND === "1";
}

/** Whether this bundle is the Codespaces playground build. */
export const PLAYGROUND_BUILD: boolean = isPlaygroundEnv(import.meta.env);

/** The playground's Core base URL: the page's own origin, else `undefined`. */
export function playgroundCoreUrl(
	playground: boolean,
	origin: string | undefined
): string | undefined {
	if (!(playground && origin) || origin === "null") {
		return;
	}
	return origin.replace(/\/$/, "");
}
