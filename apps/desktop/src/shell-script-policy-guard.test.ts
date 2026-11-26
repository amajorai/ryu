import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// A GUARD, not a regression test: it passes on the configs as they are.
// App frames and chat widget frames are mounted from `srcdoc` and inherit the
// shell policy on top of their own (docs/desktop-extension-host-spec.md, section
// 3.1). A widget frame's own policy admits any script that carries its nonce,
// from any host, so the shell's `script-src-elem` is the one line that keeps a
// widget from loading script from another host on desktop. Nothing visible
// breaks when a host is added there, so this test is what such a change meets.
// (Security sweep, finding SA-11.)
const DESKTOP_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const SHELL_CONFIGS = [
	"src-tauri/tauri.conf.json",
	"src-tauri/tauri.standalone.conf.json",
];

const KEYWORD_SOURCE = /^'[^']+'$/;
const WHITESPACE = /\s+/;

const tauriConfigSchema = z.object({
	app: z.object({ security: z.object({ csp: z.string() }) }),
});

function shellPolicy(relativePath: string): string {
	return tauriConfigSchema.parse(
		JSON.parse(readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8"))
	).app.security.csp;
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

describe("guard: the desktop shell keeps frame scripts off other hosts", () => {
	for (const config of SHELL_CONFIGS) {
		test(`guard: ${config} has a script-src-elem without a remote source`, () => {
			const sources = directiveSources(shellPolicy(config), "script-src-elem");
			expect(sources).not.toBeNull();
			expect((sources ?? []).filter(canNameAnotherOrigin)).toEqual([]);
		});
	}
});
