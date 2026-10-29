import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsScene } from "./agents.tsx";

const { default: styles } = await import("./agents.module.css");

test("the agents scene server-renders a decorative, deterministic still", () => {
	const html = renderToStaticMarkup(<AgentsScene />);

	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain('data-testid="realm-visual-agents"');
	// The same markup on every render, with no generated ids to mismatch on hydrate.
	expect(renderToStaticMarkup(<AgentsScene />)).toBe(html);
	expect(html).not.toMatch(/\sid="/);
	expect(html).not.toMatch(/:r[0-9a-z]+:|«r/);
});

test("the agent core has every part plugged in, with the chat swap and versions", () => {
	const html = renderToStaticMarkup(<AgentsScene />);

	for (const part of [
		"agent",
		"chat",
		"voice",
		"image",
		"tools",
		"memory",
		"instructions",
	]) {
		expect(html).toContain(`>${part}</text>`);
	}
	// The original chat glyph and its diamond replacement are both drawn.
	expect(html).toContain('<circle r="2"');
	expect(html).toContain('d="M0 -2.4 L2.4 0 L0 2.4 L-2.4 0 Z"');
	// One marching flow line per wire, plus the replacement chat wire.
	expect(html.split(`class="${styles.flow}"`).length - 1).toBe(6);
	expect(html).toContain(styles.newFlow);
	// Four instruction layers: three kept versions and the one about to land.
	expect(html.split(styles.doc).length - 1).toBeGreaterThanOrEqual(4);
	expect(html).toContain("--dx:-9.58px");
});

test("every animation shorthand names its keyframes without a var()", async () => {
	// A var() in the shorthand stops CSS modules scoping the keyframe name, so the
	// rule points at an unscoped name that does not exist and nothing moves.
	const css = await Bun.file(
		new URL("./agents.module.css", import.meta.url)
	).text();
	const shorthands = css.match(/\banimation:[^;]+;/g) ?? [];

	expect(shorthands.length).toBeGreaterThan(10);
	for (const rule of shorthands) {
		expect(rule).not.toContain("var(");
	}
});
