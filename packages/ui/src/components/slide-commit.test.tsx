import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SlideCommit } from "./slide-commit.tsx";
import { inkOn, isThenable, velocityOf } from "./slide-commit-config.ts";

test("renders an accessible slider named by the label", () => {
	const html = renderToStaticMarkup(
		<SlideCommit
			doneLabel="Deleted"
			errorLabel="Couldn't delete"
			label="Delete Atlas"
			width="100%"
		/>
	);

	expect(html).toContain('role="slider"');
	expect(html).toContain('aria-label="Delete Atlas"');
	expect(html).toContain('aria-valuenow="0"');
	expect(html).toContain('data-phase="idle"');
	expect(html).toContain("Delete Atlas");
	expect(html).toContain("Couldn&#x27;t delete");
	expect(html).toContain("width:100%");
});

test("leaves theme tokens in charge unless a colour is passed", () => {
	const themed = renderToStaticMarkup(<SlideCommit label="Go" />);
	expect(themed).not.toContain("--sc-track");

	const custom = renderToStaticMarkup(
		<SlideCommit handleColor="#f5f5f5" label="Go" trackColor="#262626" />
	);
	expect(custom).toContain("--sc-track:#262626");
	expect(custom).toContain("--sc-on-ink:#111111");
});

test("removes the slider from the tab order when disabled", () => {
	const html = renderToStaticMarkup(<SlideCommit disabled label="Go" />);
	expect(html).toContain('tabindex="-1"');
	expect(html).toContain('aria-disabled="true"');
	expect(html).toContain("data-disabled");
});

test("picks a readable ink only for hex fills", () => {
	expect(inkOn("#ffffff")).toBe("#111111");
	expect(inkOn("#000")).toBe("#ffffff");
	expect(inkOn("var(--muted)")).toBeUndefined();
	expect(inkOn(undefined)).toBeUndefined();
});

test("measures release velocity from the drag history", () => {
	expect(velocityOf([])).toBe(0);
	expect(
		velocityOf([
			[0, 0],
			[100, 50],
		])
	).toBe(500);
});

test("detects promise-like confirm results", () => {
	expect(isThenable(Promise.resolve())).toBe(true);
	expect(isThenable(true)).toBe(false);
	expect(isThenable(null)).toBe(false);
});
