import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SkeletonRows } from "./skeleton.tsx";

describe("SkeletonRows", () => {
	test("names its status region so it is reachable as a labelled status", () => {
		const html = renderToStaticMarkup(<SkeletonRows />);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Loading"');
		expect(html).toContain('aria-busy="true"');
	});

	test("uses a custom label for both the accessible name and announced text", () => {
		const html = renderToStaticMarkup(
			<SkeletonRows label="Loading branches" />
		);
		expect(html).toContain('aria-label="Loading branches"');
		expect(html).toContain(">Loading branches</span>");
	});
});
