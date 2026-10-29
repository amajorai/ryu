import { describe, expect, test } from "bun:test";
import { SELECT_OPTION_COLORS } from "@ryu/ui/lib/data-grid.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { DataGridOptionBadge } from "./data-grid-option-badge.tsx";

/** The class list of the rendered badge root. */
function badgeClasses(html: string): string[] {
	return (html.match(/<span[^>]*class="([^"]*)"/)?.[1] ?? "").split(" ");
}

describe("DataGridOptionBadge", () => {
	test("puts the option's palette tint on the rounded pill itself", () => {
		const html = renderToStaticMarkup(
			<DataGridOptionBadge color="blue">Planned</DataGridOptionBadge>
		);
		const classes = badgeClasses(html);
		expect(classes).toContain("rounded-3xl");
		for (const tint of (SELECT_OPTION_COLORS.blue ?? "").split(" ")) {
			expect(classes).toContain(tint);
		}
		expect(classes).not.toContain("bg-secondary");
		expect(html).toContain("Planned");
	});

	test("keeps the neutral secondary fill for an unset or unknown color", () => {
		for (const color of [undefined, "not-a-palette-color"]) {
			const classes = badgeClasses(
				renderToStaticMarkup(
					<DataGridOptionBadge color={color}>Backlog</DataGridOptionBadge>
				)
			);
			expect(classes).toContain("bg-secondary");
			expect(classes).toContain("rounded-3xl");
		}
	});
});
