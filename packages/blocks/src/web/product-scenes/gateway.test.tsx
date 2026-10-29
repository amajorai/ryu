import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayScene } from "./gateway.tsx";

const ID_ATTRIBUTE = /\sid="/;

describe("GatewayScene", () => {
	it("server-renders a decorative scene inside the realm card wrapper", () => {
		const markup = renderToStaticMarkup(<GatewayScene />);

		expect(markup).toContain('data-testid="realm-visual-gateway"');
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain('viewBox="0 0 320 176"');
		for (const label of [
			"agent",
			"policy",
			"vault",
			"model",
			"tool",
			"approval",
			"audit",
		]) {
			expect(markup).toContain(`>${label}<`);
		}
	});

	it("renders deterministic markup with no generated ids", () => {
		const first = renderToStaticMarkup(<GatewayScene />);
		const second = renderToStaticMarkup(<GatewayScene />);

		expect(second).toBe(first);
		expect(ID_ATTRIBUTE.test(first)).toBe(false);
		expect(first).not.toContain("url(#");
	});

	it("animates only with motion allowed and pauses offscreen", async () => {
		const stylesheet = await Bun.file(
			new URL("./gateway.module.css", import.meta.url)
		).text();

		expect(stylesheet).toContain("prefers-reduced-motion: no-preference");
		expect(stylesheet).toContain(".root:not([data-inview]) *");
		expect(stylesheet).toContain("animation-play-state: paused");
		expect(stylesheet).toContain("animation-duration: 7.2s");
	});
});
