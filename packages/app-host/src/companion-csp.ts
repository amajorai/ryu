// CSP helpers for the full-HTML (Path B) Companion document. `sanitizeCspOrigin` is
// also the widget path's public-https allowlist sanitizer (`widget-assets.ts`).

import { z } from "zod";

/** A per-app CSP allowlist (the OpenAI-Apps-SDK `_meta.ui.csp` model, scoped). Only
 *  a TRUSTED/approved manifest's allowlist should ever reach here — the caller
 *  (PluginHostPanel) passes it straight from `companion.csp`, which Core emits only
 *  for built-in/moderated manifests. */
export interface CompanionCsp {
	/** Hosts added to `connect-src` (the frame may `fetch()`/XHR these directly). */
	connectDomains?: string[];
	/** Hosts added to `img-src`/`media-src` (remote asset/image loads). */
	resourceDomains?: string[];
}

const cspOriginInputSchema = z
	.unknown()
	.pipe(z.string().refine((value) => !/[\s;'"]/.test(value)));

/** Normalize an allowlist entry to a bare `https://host[:port]` origin, or null if
 *  it is not a safe https host. Rejects anything carrying CSP-delimiter characters
 *  (space, `;`, quotes, `'`) so a malicious entry cannot inject extra directives.
 *
 *  Exported so the widget path (`widget-bootstrap.ts`) shares ONE public-https
 *  allowlist sanitizer for a widget's declared `resource_domains` — the two paths
 *  must not diverge (advisor point 4). The widget path additionally needs a
 *  loopback-tolerant check for the Core PROXY origin (`http://127.0.0.1:*`), which
 *  this deliberately rejects; that is a separate, documented concern there. */
export function sanitizeCspOrigin(
	entry: z.input<typeof cspOriginInputSchema>
): string | null {
	const parsed = cspOriginInputSchema.safeParse(entry);
	if (!parsed.success) {
		return null;
	}
	let candidate = parsed.data.trim();
	if (!candidate) {
		return null;
	}
	// Bare host → assume https. Reject any non-https scheme (no http:, ws:, data:).
	if (!candidate.includes("://")) {
		candidate = `https://${candidate}`;
	}
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:") {
			return null;
		}
		const host = url.hostname;
		// Pin to an EXACT, dotted public host. Reject wildcards (`*.evil.com`), bare
		// single-label hosts (a bare TLD like `com`, or an internal name like
		// `localhost`), and any leftover delimiter. This keeps a per-app allowlist
		// entry from broadening to a whole TLD or an internal target.
		if (host.includes("*") || !host.includes(".") || /[\s;'"/]/.test(host)) {
			return null;
		}
		return url.port ? `https://${host}:${url.port}` : `https://${host}`;
	} catch {
		return null;
	}
}

/** Build the full-HTML companion's restricted policy. The egress lock
 *  (`connect-src 'none'`) and the `data:`/`blob:` asset allowance are present when
 *  this default policy is enabled. A per-app `csp` allowlist (only ever a trusted
 *  manifest's) additionally appends sanitized https origins to `connect-src` and
 *  `img-src`/`media-src`. */
export function buildHtmlCompanionCsp(csp?: CompanionCsp): string {
	const connect = (csp?.connectDomains ?? [])
		.map(sanitizeCspOrigin)
		.filter((o): o is string => o !== null);
	const resource = (csp?.resourceDomains ?? [])
		.map(sanitizeCspOrigin)
		.filter((o): o is string => o !== null);
	const connectSrc =
		connect.length > 0
			? `connect-src ${connect.join(" ")}`
			: "connect-src 'none'; webrtc 'block'";
	const imgSrc = ["img-src", "data:", "blob:", ...resource].join(" ");
	const mediaSrc = ["media-src", "data:", "blob:", ...resource].join(" ");
	return [
		"default-src 'none'",
		"script-src 'unsafe-inline' 'unsafe-eval'",
		"style-src 'unsafe-inline'",
		imgSrc,
		mediaSrc,
		"font-src data:",
		connectSrc,
		"worker-src blob:",
		"child-src blob:",
		"frame-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}
