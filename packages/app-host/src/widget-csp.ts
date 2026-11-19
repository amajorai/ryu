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

/**
 * The widget CSP (decisions doc D3, governed-compat). The `nonce` gates every
 * script (bootstrap + widget module). `connect-src 'none'` is NEVER widened, so a
 * widget cannot fetch/beacon — all ACTIVE egress goes through `callTool` -> Gateway.
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
	nonce: string,
	proxyOrigin?: string | null
): string {
	const origin = proxyOrigin ? sanitizeProxyOrigin(proxyOrigin) : null;
	const passive = origin ? `data: ${origin}` : "data:";
	return [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
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
