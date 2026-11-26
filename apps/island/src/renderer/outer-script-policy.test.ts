import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Island window mounts app frames and chat widget frames from `srcdoc`. Such
// a frame inherits the page's content policy on top of its own, and a widget
// frame's own policy admits any script that carries its nonce, from any host.
// So the PAGE policy is what keeps script elements and module imports in those
// frames off the network. Without it a widget can load a script from another
// host and send data out through that request, past the Gateway.
// (Security sweep, finding SA-11.)
const RENDERER_PAGE = join(import.meta.dirname, "index.html");

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const META_TAG = /<meta\b[^>]*>/gi;
const POLICY_HTTP_EQUIV = /\bhttp-equiv\s*=\s*["']content-security-policy["']/i;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*"([^"]*)"/i;
const FIRST_SCRIPT = /<script\b/i;
const KEYWORD_SOURCE = /^'[^']+'$/;
const NONCE_OR_HASH = /^'(?:nonce|sha256|sha384|sha512)-/i;
const WHITESPACE = /\s+/;

interface PolicyMeta {
	content: string;
	index: number;
}

/** Every content policy meta tag of the page, with its place in the text. */
function policyMetas(html: string): PolicyMeta[] {
	const metas: PolicyMeta[] = [];
	for (const match of html.matchAll(META_TAG)) {
		const tag = match[0];
		if (POLICY_HTTP_EQUIV.test(tag)) {
			metas.push({
				content: CONTENT_ATTRIBUTE.exec(tag)?.[1] ?? "",
				index: match.index,
			});
		}
	}
	return metas;
}

/** The sources of a directive (browsers use its first occurrence), or null. */
function directiveSources(policy: string, name: string): string[] | null {
	for (const part of policy.split(";")) {
		const [directive, ...sources] = part.trim().split(WHITESPACE);
		if (directive?.toLowerCase() === name) {
			return sources;
		}
	}
	return null;
}

/**
 * A source that can name another origin: a scheme, a host or a wildcard (all
 * unquoted), or 'strict-dynamic', which hands the choice of URL to a script
 * that is already admitted.
 */
function canNameAnotherOrigin(source: string): boolean {
	return (
		!KEYWORD_SOURCE.test(source) || source.toLowerCase() === "'strict-dynamic'"
	);
}

describe("Island renderer page policy", () => {
	const html = readFileSync(RENDERER_PAGE, "utf8").replace(HTML_COMMENT, "");
	const metas = policyMetas(html);
	const scriptSources = directiveSources(
		metas[0]?.content ?? "",
		"script-src-elem"
	);

	test("the page carries one content policy, ahead of its first script", () => {
		expect(metas).toHaveLength(1);
		const firstScript = html.search(FIRST_SCRIPT);
		expect(firstScript).toBeGreaterThan(-1);
		expect(metas[0]?.index).toBeLessThan(firstScript);
	});

	test("script elements and module imports cannot come from another host", () => {
		expect(scriptSources).not.toBeNull();
		expect((scriptSources ?? []).filter(canNameAnotherOrigin)).toEqual([]);
	});

	test("the page's own bundle and the inline scripts of every frame still load", () => {
		expect(scriptSources).toContain("'self'");
		expect(scriptSources).toContain("'unsafe-inline'");
		// Browsers ignore 'unsafe-inline' once the directive holds a nonce or a
		// hash, and every app and widget frame would then stay silent.
		expect(
			(scriptSources ?? []).filter((source) => NONCE_OR_HASH.test(source))
		).toEqual([]);
	});
});
