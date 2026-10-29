import { expect, test } from "bun:test";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BunPlugin } from "bun";
import config from "./vite.library-source-proof.config.ts";

GlobalRegistrator.register();
const mock = await import("./library-source-proof.mock.ts");

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const entry = path.join(
	desktopRoot,
	"src/components/library/ContributedLibrarySection.tsx"
);

// Applies the harness's own `resolve.alias` list (the same one Vite uses) so the
// bundle sees the mock exactly where the browser page would.
function harnessAliasPlugin(): BunPlugin {
	const aliases = config.resolve?.alias;
	if (!Array.isArray(aliases)) {
		throw new Error("library-source-proof config must declare array aliases");
	}
	return {
		name: "library-source-proof-aliases",
		setup(build) {
			build.onResolve({ filter: /^@\// }, (args) => {
				for (const alias of aliases) {
					if (typeof alias.find !== "string") {
						continue;
					}
					if (args.path === alias.find) {
						return { path: alias.replacement };
					}
				}
				const relative = args.path.slice(2);
				return { path: Bun.resolveSync(`./${relative}`, desktopRoot) };
			});
		},
	};
}

test("the aliased TabsContext mock provides every export ContributedLibrarySection imports", async () => {
	const result = await Bun.build({
		entrypoints: [entry],
		packages: "external",
		plugins: [harnessAliasPlugin()],
		throw: false,
	});
	expect(result.logs.map((log) => log.message)).toEqual([]);
	expect(result.success).toBe(true);
});

test("the aliased useTabSelector selects the same openTab that useTabsContext exposes", () => {
	const details: unknown[] = [];
	const record = (event: Event) => {
		if (event instanceof CustomEvent) {
			details.push(event.detail);
		}
	};
	window.addEventListener("collection-open", record);
	try {
		const selected = mock.useTabSelector((state) => state.openTab);
		const again = mock.useTabSelector((state) => state.openTab);
		expect(selected).toBe(again);
		expect(selected).toBe(mock.useTabsContext().openTab);
		selected("/chat?conversationId=r1", { title: "Record one" });
	} finally {
		window.removeEventListener("collection-open", record);
	}
	expect(details).toEqual([
		{ path: "/chat?conversationId=r1", options: { title: "Record one" } },
	]);
});
