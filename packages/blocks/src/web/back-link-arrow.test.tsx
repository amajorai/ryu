// A back link draws its arrow as a mirrored icon, so the link's text (and the
// catalog key) carries no "←" glyph that would point forward in Arabic.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BackLinkArrow } from "./back-link-arrow.tsx";
import { LinkArrow } from "./link-arrow.tsx";

test("the back arrow is a hidden, RTL-mirrored icon with no text glyph", () => {
	const html = renderToStaticMarkup(
		<a href="/challenges">
			<BackLinkArrow /> All opportunities
		</a>
	);
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain("rtl:-scale-x-100");
	expect(html).toContain("data-directional-icon");
	expect(html).not.toMatch(/[←→]/);
});

test("the back arrow points the other way from the call-to-action arrow", () => {
	const back = renderToStaticMarkup(<BackLinkArrow />);
	const forward = renderToStaticMarkup(<LinkArrow />);
	expect(back).not.toBe(forward);
});
