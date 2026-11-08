import { expo } from "@better-auth/expo";

/**
 * The `@better-auth/expo` server plugin without its session-cookie handoff.
 *
 * Upstream, `expo()` registers an after-hook on `/callback/*`,
 * `/magic-link/verify` and `/verify-email` that copies the full `Set-Cookie`
 * header into any trusted non-http redirect as `?cookie=`. Ryu trusts the bare
 * `ryu://` scheme, which matches every `ryu://` URL, and any installed app can
 * register that scheme. A magic link anyone can request for any address would
 * then deliver the victim's session to whichever app answers `ryu://`.
 *
 * No first-party client needs the handoff: mobile signs in with device
 * authorization and holds a bearer token, and the extension uses a one-time
 * token. The plugin's request rewrite (`expo-origin` to `origin`) and Better
 * Auth's authorization-proxy endpoint (required for Expo OAuth in WebBrowser)
 * stay enabled; only the after-hooks that copy session cookies into redirects
 * are dropped. Upstream 1.7.16+ fixes GHSA-4wq4-2ppv-q3hg on the proxy itself;
 * removing the plugin entirely would break native OAuth unless replaced.
 */
export function expoWithoutSessionHandoff(): ReturnType<typeof expo> {
	const plugin = expo();
	return { ...plugin, hooks: { ...plugin.hooks, after: [] } };
}
