import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import Footer from "./footer.tsx";

test("footer uses the cursor-aware outline Ryu mark", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain('data-testid="footer-ryu-logo"');
	expect(html).toContain('stroke="currentColor"');
	expect(html).toContain('class="aurora-container"');
	expect(html).not.toContain(">ryu</div>");
});

test("footer carries the universal integration positioning", () => {
	const html = renderToStaticMarkup(<Footer />);

	expect(html).toContain("The universal AI integration layer");
	expect(html).toContain(
		"We deploy and keep your agents running for you. Connect the tools it needs and integrate where you want it to run."
	);
	expect(html).not.toContain("Ryu is the integration layer for AI.");
	expect(html).not.toContain("We deploy and run AI agents safely in the cloud");
	expect(html).not.toContain("Autonomous AI in the cloud");
});

test("footer keeps GitHub and its star count in the build row", () => {
	const html = renderToStaticMarkup(<Footer githubStargazersCount={1234} />);
	const learnColumn = html.slice(
		html.indexOf('<h4 class="mb-4 font-semibold">Learn</h4>'),
		html.indexOf('<h4 class="mb-4 font-semibold">Company</h4>')
	);

	expect(learnColumn).not.toContain("Open Source");
	expect(html.match(/aria-label="Ryu on GitHub"/g)).toHaveLength(1);
	expect(html).toContain("1,234");
});
