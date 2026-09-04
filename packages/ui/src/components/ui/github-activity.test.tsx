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
});
