import { expect, test } from "bun:test";
import { AGENT_BANNER_BASE } from "./agent-banner-dialog.tsx";

// The banner base is authored twice: on the module's local `.base` class (CSS
// modules stay pure, so it cannot be a global `:root` token) and as the
// exported string harnesses paint previews with. Guard the two copies.
const BASE_BACKGROUND_PATTERN = /\.base\s*\{\s*background:\s*([^;]+);/;
const WHITESPACE_PATTERN = /\s+/g;
const OPEN_PAREN_SPACE_PATTERN = /\(\s/g;
const CLOSE_PAREN_SPACE_PATTERN = /\s\)/g;

function normalizeCssValue(value: string): string {
	return value
		.replace(WHITESPACE_PATTERN, " ")
		.replace(OPEN_PAREN_SPACE_PATTERN, "(")
		.replace(CLOSE_PAREN_SPACE_PATTERN, ")")
		.trim();
}

test("AGENT_BANNER_BASE matches the banner module's base gradient", async () => {
	const stylesheet = await Bun.file(
		new URL("./agent-banner-dialog.module.css", import.meta.url)
	).text();
	const moduleBase = BASE_BACKGROUND_PATTERN.exec(stylesheet)?.[1];

	expect(moduleBase).toBeDefined();
	expect(normalizeCssValue(moduleBase ?? "")).toBe(
		normalizeCssValue(AGENT_BANNER_BASE)
	);
	expect(AGENT_BANNER_BASE).not.toContain("var(");
});
