// The booklet's page controls under each reading direction: the paging keys
// follow the direction, so the tooltips name the key that turns each way.
import { describe, expect, test } from "bun:test";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import { PassportPageNav } from "./passport-page-nav.tsx";

function titles(direction: "ltr" | "rtl"): string[] {
	const markup = renderToStaticMarkup(
		<DirectionProvider direction={direction}>
			<PassportPageNav
				canNext
				canPrevious={false}
				caption="Pages 2–3"
				next={() => undefined}
				previous={() => undefined}
			/>
		</DirectionProvider>
	);
	return [...markup.matchAll(/title="([^"]*)"/gu)].map(
		(match) => match[1] ?? ""
	);
}

describe("PassportPageNav", () => {
	test("names the left and right arrow keys in left-to-right reading", () => {
		expect(titles("ltr")).toEqual(["Previous page (←)", "Next page (→)"]);
	});

	test("swaps the arrow keys under dir=rtl, matching the paging keys", () => {
		expect(titles("rtl")).toEqual(["Previous page (→)", "Next page (←)"]);
	});

	test("disables the control that has no page to turn to", () => {
		const markup = renderToStaticMarkup(
			<PassportPageNav
				canNext={false}
				canPrevious
				caption="Page 1"
				next={() => undefined}
				previous={() => undefined}
			/>
		);
		const buttons = [...markup.matchAll(/<button([^>]*)>/gu)].map(
			(match) => match[1] ?? ""
		);
		expect(buttons).toHaveLength(2);
		expect(buttons[0]).toContain('aria-label="Previous page"');
		expect(buttons[0]).not.toContain('disabled=""');
		expect(buttons[1]).toContain('aria-label="Next page"');
		expect(buttons[1]).toContain('disabled=""');
		expect(markup).toContain("Page 1");
	});
});
