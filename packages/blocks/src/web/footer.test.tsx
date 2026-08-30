import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import Footer from "./footer.tsx";

test("footer uses the cursor-aware outline Ryu mark", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain('data-testid="footer-ryu-logo"');
	expect(html).toContain('stroke="currentColor"');
	expect(html).not.toContain("aurora-container");
	expect(html).not.toContain(">ryu</div>");
});

test("footer carries the universal integration positioning", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain("The universal AI integration layer");
	expect(html).not.toContain("We deploy and run AI agents safely in the cloud");
	expect(html).not.toContain("Autonomous AI in the cloud");
});
