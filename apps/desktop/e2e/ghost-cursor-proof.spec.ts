import path from "node:path";
import { expect, test } from "@playwright/test";
import { ghostCursorHueFor } from "../../island/src/main/control-protocol.ts";

test.describe.configure({ timeout: 90_000 });

const CURSOR_IDENTITY = {
	agentId: "@ryu/codex",
	agentName: "Codex",
	agentTitle: "Computer-use agent",
	sessionTitle:
		"Polish Shadow’s computer-use cursor with a clear session title and agent identity",
	avatarEmoji: "✦",
};
const CURSOR_HUE = ghostCursorHueFor(CURSOR_IDENTITY, "proof");

declare global {
	interface Window {
		__ghost?: (
			phase: string,
			x: number,
			y: number,
			hue: number,
			intent: string,
			identity: typeof CURSOR_IDENTITY
		) => void;
	}
}

test("renders the agent session cursor and proves its idle fade", async ({
	page,
}) => {
	await page.goto("/ghost-cursor-proof.html");

	await expect(page.getByTestId("ghost-cursor-proof")).toBeVisible();
	const overlay = page.frameLocator('[data-testid="ghost-cursor-frame"]');
	await expect(overlay.locator("#label-title")).toHaveText(
		/Polish Shadow’s computer-use cursor/
	);
	await expect(overlay.locator("#label-avatar")).toHaveText("✦");
	await expect(overlay.locator("#label-subtitle")).toContainText("Codex");
	await expect(overlay.locator("#label-subtitle")).toContainText(
		"Click “Send”"
	);
	await expect(overlay.locator("#label-title")).toHaveCSS(
		"mask-image",
		/linear-gradient/
	);
	await expect(overlay.locator("#pointer path")).toHaveCount(1);
	const cursor = overlay.locator("#cursor");
	const pointerFill = await overlay
		.locator("#pointer .cursor-body")
		.evaluate((element) => getComputedStyle(element).fill);
	expect(pointerFill).not.toBe("rgb(248, 250, 252)");
	const labelFill = await overlay
		.locator("#label")
		.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(labelFill).toBe(pointerFill);
	const borderWidths = await Promise.all([
		overlay
			.locator("#label")
			.evaluate((element) => getComputedStyle(element).borderTopWidth),
		overlay
			.locator("#label-avatar")
			.evaluate((element) => getComputedStyle(element).borderTopWidth),
		overlay
			.locator("#pointer .cursor-body")
			.evaluate((element) => getComputedStyle(element).stroke),
	]);
	expect(borderWidths).toEqual(["0px", "0px", "none"]);
	const textContrast = await overlay.locator("#label").evaluate((element) => {
		const luminance = (color: string) => {
			const [red = 0, green = 0, blue = 0] =
				color
					.match(/\d+(?:\.\d+)?/g)
					?.slice(0, 3)
					.map(Number) ?? [];
			const linear = (channel: number) => {
				const normalized = channel / 255;
				return normalized <= 0.040_45
					? normalized / 12.92
					: ((normalized + 0.055) / 1.055) ** 2.4;
			};
			return (
				0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
			);
		};
		const background = luminance(getComputedStyle(element).backgroundColor);
		const title = luminance(
			getComputedStyle(element.querySelector("#label-title")!).color
		);
		const subtitle = luminance(
			getComputedStyle(element.querySelector("#label-subtitle")!).color
		);
		const contrast = (ink: number) => {
			const lighter = Math.max(background, ink);
			const darker = Math.min(background, ink);
			return (lighter + 0.05) / (darker + 0.05);
		};
		return { title: contrast(title), subtitle: contrast(subtitle) };
	});
	expect(textContrast.title).toBeGreaterThanOrEqual(4.5);
	expect(textContrast.subtitle).toBeGreaterThanOrEqual(4.5);
	const initialPosition = await cursor.evaluate(
		(element) => element.style.transform
	);
	expect(initialPosition).toBe("translate(390px, 166px)");
	const nextPosition = await cursor.evaluate(
		(element, payload) => {
			const ghost = window;
			ghost.__ghost?.(
				"move",
				512,
				224,
				payload.hue,
				"Click “Send”",
				payload.identity
			);
			return element.style.transform;
		},
		{ hue: CURSOR_HUE, identity: CURSOR_IDENTITY }
	);
	expect(nextPosition).toBe("translate(512px, 224px)");
	const motion = await cursor.evaluate(
		(element) => getComputedStyle(element).transition
	);
	expect(motion).toContain("0.32s");
	const screenshotPosition = await cursor.evaluate(
		(element, payload) => {
			const ghost = window;
			ghost.__ghost?.(
				"move",
				390,
				166,
				payload.hue,
				"Click “Send”",
				payload.identity
			);
			return element.style.transform;
		},
		{ hue: CURSOR_HUE, identity: CURSOR_IDENTITY }
	);
	expect(screenshotPosition).toBe("translate(390px, 166px)");
	await expect(page.getByTestId("ghost-cursor-state")).toHaveText(/Visible/);
	await expect(cursor).toHaveCSS("opacity", "0.68");
	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/shadow-agent-session-cursor.png"
		),
	});

	await page.getByTestId("ghost-cursor-replay").click();
	await expect(page.getByTestId("ghost-cursor-state")).toHaveText(/Visible/);
	await expect(cursor).toHaveCSS("opacity", "0.68");

	await expect(page.getByTestId("ghost-cursor-state")).toHaveText(
		/Faded after 2.4s idle/,
		{ timeout: 4000 }
	);
});
