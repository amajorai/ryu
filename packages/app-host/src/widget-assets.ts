// Governed passive-asset rewriting for a Ryu App WIDGET document. A widget's
// DECLARED remote `resource_domains` assets are pointed at the single Core proxy
// origin (`/api/widgets/asset`) so the Gateway sees and allowlists every fetch; any
// other remote URL is left untouched and then blocked by the widget CSP.

import { sanitizeCspOrigin } from "./companion-csp.ts";

/** The Core asset-proxy wiring the host injects so a widget's DECLARED remote
 *  assets render while every egress stays governed. When present (and the widget
 *  declared `resourceDomains`), the mount widens the passive-asset CSP to the
 *  proxy origin and rewrites matching asset URLs to `/api/widgets/asset`. */
export interface WidgetAssetProxy {
	/** Minted widget instance id — the proxy's capability + provenance handle. */
	instanceId: string;
	/** The Core node origin (e.g. `http://127.0.0.1:7980`), loopback http. */
	proxyOrigin: string;
	/** The widget's declared remote passive-asset hosts (from `csp.resource_domains`). */
	resourceDomains: string[];
	/** Widget resource uri; scopes the server-side `resource_domains` allowlist. */
	templateUri: string;
}

/** Normalize a declared `resource_domains` entry to its bare lowercase host, reusing
 *  the shared public-https {@link sanitizeCspOrigin} then extracting the hostname.
 *  Returns null for anything not a safe exact public host (wildcards/http rejected). */
export function resourceDomainHost(entry: string): string | null {
	const origin = sanitizeCspOrigin(entry);
	if (!origin) {
		return null;
	}
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Match `url(...)` targets inside CSS text (inline `style` + `<style>` bodies) so
 *  declared remote asset URLs there are rewritten too. Top-level (never in a loop). */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/** Build the `/api/widgets/asset` URL for one declared remote asset, or null if the
 *  raw value is not an absolute http(s) URL whose host is in the widget's allowlist.
 *  A non-match is left untouched (and then simply blocked by the CSP — fail-closed). */
export function proxiedAssetUrl(
	raw: string,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): string | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") {
		return null;
	}
	if (!allowHosts.has(u.hostname.toLowerCase())) {
		return null;
	}
	const q = new URLSearchParams({ instance: proxy.instanceId, url: u.href });
	if (proxy.templateUri) {
		q.set("template", proxy.templateUri);
	}
	return `${origin}/api/widgets/asset?${q.toString()}`;
}

/** Rewrite a `srcset` value, proxying each descriptor's URL that is allowlisted. */
export function rewriteSrcset(
	value: string,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): string {
	return value
		.split(",")
		.map((part) => {
			const seg = part.trim();
			if (!seg) {
				return seg;
			}
			const space = seg.indexOf(" ");
			const url = space === -1 ? seg : seg.slice(0, space);
			const descriptor = space === -1 ? "" : seg.slice(space);
			const proxied = proxiedAssetUrl(url, origin, allowHosts, proxy);
			return `${proxied ?? url}${descriptor}`;
		})
		.join(", ");
}

/** Rewrite `url(...)` targets inside CSS text (inline style + `<style>` bodies). */
export function rewriteCssUrls(
	css: string,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): string {
	return css.replace(CSS_URL_RE, (match, quote: string, url: string) => {
		const proxied = proxiedAssetUrl(url.trim(), origin, allowHosts, proxy);
		return proxied ? `url(${quote}${proxied}${quote})` : match;
	});
}

/** Point a widget's DECLARED remote passive assets at the Core proxy so they render
 *  under the governed CSP. Covers `src`/`poster` attributes, `srcset` descriptors,
 *  and `url(...)` in inline `style` attributes and `<style>` bodies — the forms a
 *  single-file widget bundle uses. Anything missed stays a raw remote URL and is
 *  blocked by the CSP (never a broken-open egress). */
export function rewriteWidgetAssets(
	doc: Document,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): void {
	for (const el of Array.from(doc.querySelectorAll("[src],[poster]"))) {
		for (const attr of ["src", "poster"]) {
			const v = el.getAttribute(attr);
			if (!v) {
				continue;
			}
			const proxied = proxiedAssetUrl(v, origin, allowHosts, proxy);
			if (proxied) {
				el.setAttribute(attr, proxied);
			}
		}
	}
	for (const el of Array.from(doc.querySelectorAll("[srcset]"))) {
		const v = el.getAttribute("srcset");
		if (v) {
			el.setAttribute("srcset", rewriteSrcset(v, origin, allowHosts, proxy));
		}
	}
	for (const el of Array.from(doc.querySelectorAll("[style]"))) {
		const v = el.getAttribute("style");
		if (v?.includes("url(")) {
			el.setAttribute("style", rewriteCssUrls(v, origin, allowHosts, proxy));
		}
	}
	for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
		const css = styleEl.textContent;
		if (css?.includes("url(")) {
			styleEl.textContent = rewriteCssUrls(css, origin, allowHosts, proxy);
		}
	}
}
