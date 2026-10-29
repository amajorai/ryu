import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "./badge.tsx";

/** The class list of the rendered badge root. */
function badgeClasses(html: string): string[] {
	return (html.match(/<span[^>]*class="([^"]*)"/)?.[1] ?? "").split(" ");
}

describe("Badge tint", () => {
	test("a tint replaces the variant fill on the pill itself", () => {
		const classes = badgeClasses(
			renderToStaticMarkup(
				<Badge tint="amber" variant="secondary">
					Engine
				</Badge>
			)
		);
		expect(classes).toContain("bg-warning/10");
		expect(classes).toContain("text-status-warning");
		expect(classes).not.toContain("bg-secondary");
		expect(classes).toContain("rounded-3xl");
	});

	test("no tint leaves the variant fill untouched", () => {
		const classes = badgeClasses(
			renderToStaticMarkup(<Badge variant="secondary">Engine</Badge>)
		);
		expect(classes).toContain("bg-secondary");
	});
});
