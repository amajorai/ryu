// The badge reads the locale through a client hook, so it must stay a client
// component: the public agent page is an async server component that renders
// it directly, and a hook call there throws during the server render.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { PoweredByRyuBadge } from "./powered-by-ryu.tsx";

describe("PoweredByRyuBadge", () => {
	test("is marked as a client component", () => {
		const source = readFileSync(
			new URL("./powered-by-ryu.tsx", import.meta.url),
			"utf8"
		);
		expect(source.startsWith('"use client";')).toBe(true);
	});

	test("renders one sentence with the product name emphasized", () => {
		const html = renderToStaticMarkup(<PoweredByRyuBadge source="test" />);
		expect(html).toContain("Powered by <strong");
		expect(html).toContain(">Ryu</strong>");
		expect(html).toContain("utm_source=test");
	});
});
