// The Content-Security-Policy for a Ryu App WIDGET document (decisions doc D3) and
// the loopback-tolerant validator for the Core asset-proxy origin it may widen to.
// See `widget-bootstrap.ts` for the delivery model this policy pins.

import { z } from "zod";

/** A widget's optional CSP hints (spec §1.1 `WidgetCsp`). Defined locally so this
 *  module is self-contained. `resource_domains` is the widget's declared remote
 *  passive-asset hosts; the mount rewrites matching URLs through the Core proxy
 *  (governed egress). `connect_domains` remains IGNORED — active fetch never opens
 *  (`connect-src 'none'`); a widget that needs data calls a tool via the bridge. */
export interface WidgetCsp {
	connect_domains?: string[];
	resource_domains?: string[];
}

const proxyOriginSchema = z
	.unknown()
	.pipe(z.string().refine((origin) => !/[\s;'"]/.test(origin)));

/** Validate the Core PROXY origin to a bare `scheme://host[:port]`, accepting
 *  loopback **http** (which {@link sanitizeCspOrigin} rejects, being public-https
 *  only). Still rejects CSP-delimiter chars so the (host-controlled, trusted) node
 *  URL can never inject extra directives. Returns null for anything unparseable. */
export function sanitizeProxyOrigin(
	origin: z.input<typeof proxyOriginSchema>
): string | null {
	const parsed = proxyOriginSchema.safeParse(origin);
	if (!parsed.success) {
		return null;
	}
	try {
		const u = new URL(parsed.data.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return null;
		}
		return `${u.protocol}//${u.host}`;
	} catch {
		return null;
	}
}

/** One `'sha256-<base64>'` source expression and nothing else, so a value handed to
 *  {@link buildWidgetCsp} can never add a keyword, a host or a directive. */
const SCRIPT_HASH_SOURCE = /^'sha256-[A-Za-z0-9+/]{43}='$/;

/**
 * The second policy every widget document carries, beside {@link buildWidgetCsp}.
 * A load must pass both. This one names no hash and no host, so it admits INLINE
 * script elements only and refuses every script element or module import that
 * names an address. It is needed because a hash source on its own also admits a
 * script element whose `integrity` attribute names a listed hash, whatever its
 * address. Which inline text may run stays decided by the hash list.
 */
export const WIDGET_SCRIPT_ELEMENT_CSP = "script-src-elem 'unsafe-inline'";

/**
 * The widget CSP (decisions doc D3, governed-compat). `scriptHashes` are the
 * `'sha256-...'` sources of the scripts the host delivered (the bootstrap and the
 * widget's own inline scripts, see `widget-script-hash.ts`); they are the ONLY
 * script sources. There is no nonce, no host and no scheme source, so script
 * already running in the frame cannot admit new script text or a script from an
 * address. An empty list admits no script at all. `connect-src 'none'` is NEVER
 * widened, so a widget cannot fetch/beacon. All ACTIVE egress goes through
 * `callTool` -> Gateway.
 *
 * `proxyOrigin` (the Core `/api/widgets/asset` origin) is the ONLY widening: when a
 * widget declared remote `resource_domains`, the mount passes it here and rewrites
 * matching asset URLs to that proxy, so `img-src`/`font-src`/`media-src` add exactly
 * that ONE Core origin (in addition to `data:`). The raw remote host is NEVER in the
 * CSP — a widget's passive assets can only load THROUGH the governed proxy, which
 * allowlists and audits every fetch server-side. Omit `proxyOrigin` (no declared
 * assets) and the CSP is the original `data:`-only egress lock, unchanged.
 */
export function buildWidgetCsp(
	scriptHashes: readonly string[],
	proxyOrigin?: string | null
): string {
	const origin = proxyOrigin ? sanitizeProxyOrigin(proxyOrigin) : null;
	const passive = origin ? `data: ${origin}` : "data:";
	const hashes = scriptHashes.filter((source) =>
		SCRIPT_HASH_SOURCE.test(source)
	);
	return [
		"default-src 'none'",
		`script-src ${hashes.length > 0 ? hashes.join(" ") : "'none'"}`,
		"style-src 'unsafe-inline'",
		`img-src ${passive}`,
		`font-src ${passive}`,
		`media-src ${passive}`,
		"connect-src 'none'",
		"webrtc 'block'",
		"frame-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}
