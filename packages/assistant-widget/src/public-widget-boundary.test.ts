// Guards the code split: the launcher shell, its loader and the morph must not
// statically reach the chat surface, runtimes, settings or transports. Those
// belong to the session chunk that loads on first open.
import { describe, expect, test } from "bun:test";

const SRC = new URL("./", import.meta.url);
const EAGER_ROOTS = ["public-widget.tsx", "deferred-session.tsx", "morph.tsx"];
const LAZY_ONLY = [
	"assistant-panel.tsx",
	"assistant-session.tsx",
	"assistant-turn.ts",
	"chat.tsx",
	"guest-chat.ts",
	"local-node.ts",
	"page-context.tsx",
	"page-tools.tsx",
	"runtime-controls.tsx",
	"use-assistant-session.ts",
	"use-page-context.ts",
];
const LAZY_PACKAGES = ["@ryu/blocks", "@ryu/browser-local-ai"];
const VALUE_IMPORT = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms;

async function eagerClosure(): Promise<{
	files: Set<string>;
	packages: Set<string>;
}> {
	const files = new Set<string>();
	const packages = new Set<string>();
	const queue = [...EAGER_ROOTS];
	for (let file = queue.shift(); file; file = queue.shift()) {
		if (files.has(file)) {
			continue;
		}
		files.add(file);
		const source = await Bun.file(new URL(file, SRC)).text();
		for (const [, specifier] of source.matchAll(VALUE_IMPORT)) {
			if (!specifier) {
				continue;
			}
			if (specifier.startsWith("./")) {
				if (/\.(?:ts|tsx)$/.test(specifier)) {
					queue.push(specifier.slice(2));
				}
				continue;
			}
			packages.add(specifier);
		}
	}
	return { files, packages };
}

describe("Ask Ryu eager boundary", () => {
	test("the launcher closure stays off the session chunk", async () => {
		const { files, packages } = await eagerClosure();

		expect(files.has("public-widget.tsx")).toBe(true);
		expect(files.has("browser-context.ts")).toBe(true);
		for (const lazy of LAZY_ONLY) {
			expect({ file: lazy, eager: files.has(lazy) }).toEqual({
				eager: false,
				file: lazy,
			});
		}
		for (const specifier of packages) {
			const heavy = LAZY_PACKAGES.some((name) => specifier.startsWith(name));
			expect({ heavy, specifier }).toEqual({ heavy: false, specifier });
		}
	});
});
