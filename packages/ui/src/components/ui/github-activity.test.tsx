import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubActivity } from "./github-activity.tsx";

describe("GitHubActivity", () => {
	it("renders caller-provided activity with a custom metric label", () => {
		const html = renderToStaticMarkup(
			<GitHubActivity
				contributions={[
					{ count: 1, date: "2026-09-01", level: 1 },
					{ count: 3, date: "2026-09-02", level: 4 },
				]}
				unit={{ plural: "requests", singular: "request" }}
			/>
		);

		expect(html).toContain('data-slot="github-activity"');
		expect(html).toContain("4 requests in 2026");
		expect(html).not.toContain("github-contributions-api");
	});

	it("hands the repo panel radius to Motion so layout animation corrects it", () => {
		const html = renderToStaticMarkup(
			<GitHubActivity
				contributions={[{ count: 1, date: "2026-09-01", level: 1 }]}
				repos={[{ count: 4, name: "ryu" }]}
			/>
		);
		const marker = html.indexOf('data-slot="github-activity-panel"');
		const panelTag = html.slice(
			html.lastIndexOf("<div", marker),
			html.indexOf(">", marker)
		);

		expect(marker).toBeGreaterThan(-1);
		// Motion scale-corrects only radii in its own values (style/animate); a
		// class or custom-property radius would stretch during the open animation.
		expect(panelTag).toMatch(/(?<![\w-])border-radius:18px/);
	});
});
