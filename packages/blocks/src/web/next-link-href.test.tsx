import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Link from "next/link";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nextLinkHref } from "./next-link-href.ts";

let fixtureDirectory: string;
let renderAppLink: typeof import("./next-link-app.fixture.tsx").renderAppLink;

beforeAll(async () => {
	fixtureDirectory = await mkdtemp(join(tmpdir(), "blocks-next-link-"));
	// Next's native SSR build resolves its RSC client to this bundled provider.
	// Bundle the real App Router Link with that alias, without replacing modules.
	const result = await Bun.build({
		entrypoints: [
			new URL("./next-link-app.fixture.tsx", import.meta.url).pathname,
		],
		target: "bun",
		outdir: fixtureDirectory,
		external: ["@vercel/turbopack-ecmascript-runtime/*"],
		plugins: [
			{
				name: "next-native-ssr",
				setup(build) {
					build.onResolve(
						{ filter: /^react-server-dom-webpack\/client$/ },
						() => ({
							path: import.meta
								.resolve(
									"next/dist/compiled/react-server-dom-webpack/client.node.js"
								)
								.slice(7),
						})
					);
				},
			},
		],
	});
	if (!result.success) {
		throw new AggregateError(
			result.logs,
			"Could not build genuine Next App Router Link"
		);
	}
	const [output] = result.outputs;
	if (!output) {
		throw new Error("Next App Router Link fixture build produced no output");
	}
	const fixture = await import(output.path);
	renderAppLink = fixture.renderAppLink;
});

afterAll(async () => {
	if (fixtureDirectory) {
		await rm(fixtureDirectory, { recursive: true, force: true });
	}
});

describe("authored destinations through genuine Next Link", () => {
	for (const href of [
		"/products/core",
		"/platform?source=nav&source=menu#infra",
		"/search?q=a%20b&literal=%23&empty=#results",
		"?tab=details#section",
		"#infra",
		"../products/core?tab=api#examples",
		"https://docs.example.com/path?language=en#api",
		"//docs.example.com/path?language=en#api",
		"mailto:hello@example.com?subject=Hello%20Ryu",
		"/encoded%3Fpath%23part?x=1#hash?query",
	]) {
		test(`preserves ${href}`, () => {
			const authored = renderToStaticMarkup(
				createElement(Link, { href }, "Destination")
			);
			const adapted = renderToStaticMarkup(
				createElement(Link, { href: nextLinkHref(href) }, "Destination")
			);
			expect(adapted).toBe(authored);
			expect(renderAppLink(href, true)).toBe(renderAppLink(href, false));
		});
	}

	for (const href of ["/blog/[slug]", "/blog/[...slug]?tab=1#title"]) {
		test(`retains App Router rejection for ${href}`, () => {
			expect(() => renderAppLink(href, true)).toThrow("Dynamic href");
		});
	}
});
