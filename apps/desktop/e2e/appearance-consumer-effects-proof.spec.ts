import { expect, test, type Locator, type Page } from "@playwright/test";

const STORY = "/appearance-consumer-effects-proof.html";
const css = (node: Locator, property: string) =>
	node.evaluate(
		(element, key) => getComputedStyle(element).getPropertyValue(key),
		property,
	);
// Compare rendered colors, rather than equivalent browser CSS serializations.
const rgba = (node: Locator) =>
	node.evaluate((element) => {
		const value = getComputedStyle(element).backgroundColor;
		if (!CSS.supports("color", value))
			throw new Error(`Invalid computed color: ${value}`);
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const context = canvas.getContext("2d", { colorSpace: "srgb" });
		if (!context)
			throw new Error("Canvas2D is unavailable for rendered color comparison");
		context.fillStyle = value;
		context.fillRect(0, 0, 1, 1);
		return Array.from(context.getImageData(0, 0, 1, 1).data);
	});
const colorDelta = (left: number[], right: number[]) => {
	expect(left).toHaveLength(4);
	expect(right).toHaveLength(4);
	return Math.max(
		...left.map((channel, index) => Math.abs(channel - right[index])),
	);
};
const pageFailures = new WeakMap<Page, string[]>();

async function open(page: Page, name: string) {
	await page
		.getByTestId("settings")
		.getByRole("button", { name, exact: true })
		.click();
}
const SWITCH_TITLES = {
	"pointer-cursor-toggle": "Pointer cursor",
	"chrome-shadows-toggle": "Navigation & sidebar shadows",
	"dialog-overlay-blur-toggle": "Blur dialog backgrounds",
	"inverted-backgrounds-toggle": "Invert overlay backgrounds",
	"friendly-names-toggle": "Friendly names",
	"animations-enabled-toggle": "Enable animations",
	"stream-animation-toggle": "Animate streaming chat text",
} as const;
async function toggle(
	page: Page,
	id: keyof typeof SWITCH_TITLES,
	enabled: boolean,
) {
	// Anchor to the real Item boundary: text wrappers may change with motion.
	const row = page
		.getByTestId("settings")
		.locator('[data-slot="item"]')
		.filter({
			has: page.getByText(SWITCH_TITLES[id], { exact: true }),
		});
	await expect(row).toHaveCount(1);
	const control = row.getByRole("switch");
	await expect(control).toHaveCount(1);
	await expect(control).toBeVisible();
	if ((await control.getAttribute("aria-checked")) !== String(enabled))
		await control.click();
	// Distinguish a rendering failure from a stale control locator.
	expect(pageFailures.get(page) ?? []).toEqual([]);
	await expect(page.getByTestId("settings")).toBeVisible();
	await expect(page.getByTestId("consumer-card")).toBeVisible();
	await expect(control).toHaveAttribute("aria-checked", String(enabled));
}

test.beforeEach(async ({ page }) => {
	const failures: string[] = [];
	pageFailures.set(page, failures);
	page.on("pageerror", (error) => failures.push(error.stack ?? error.message));
	page.on("crash", () => failures.push("Playwright page crash"));
	await page.setViewportSize({ width: 1600, height: 1100 });
	await page.goto(STORY);
	await expect(page.getByTestId("consumer-card")).toBeVisible();
	await expect(page.locator("html")).toHaveClass(/dark/);
});

test.afterEach(async ({ page }, testInfo) => {
	const failures = pageFailures.get(page) ?? [];
	await testInfo.attach("appearance-consumer-page-errors", {
		body: JSON.stringify(failures, null, 2),
		contentType: "application/json",
	});
	expect(
		failures,
		"Real consumer rendering must not raise page errors or crash",
	).toEqual([]);
});

test("selected fonts reach rendered interface, heading and code after restart", async ({
	page,
}) => {
	await open(page, "Layout & text");
	for (const [index, name] of [
		[0, "Geist"],
		[1, "Inter"],
		[2, "System Mono"],
	] as const) {
		await page.getByTestId("settings").getByRole("combobox").nth(index).click();
		await page
			.getByRole("listbox")
			.getByRole("option", { name, exact: true })
			.click();
	}
	const verify = async () => {
		await expect
			.poll(() => css(page.getByTestId("consumer-text"), "font-family"))
			.toContain("Geist");
		await expect
			.poll(() => css(page.getByTestId("consumer-heading"), "font-family"))
			.toContain("Inter");
		await expect
			.poll(() => css(page.getByTestId("consumer-code"), "font-family"))
			.toContain("ui-monospace");
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const geist = await document.fonts.load('16px "Geist Variable"');
					const inter = await document.fonts.load('16px "Inter Variable"');
					return (
						geist.length > 0 &&
						inter.length > 0 &&
						geist.every((face) => face.status === "loaded") &&
						inter.every((face) => face.status === "loaded") &&
						document.fonts.check('16px "Geist Variable"') &&
						document.fonts.check('16px "Inter Variable"')
					);
				}),
			)
			.toBe(true);
	};
	await verify();
	await page.reload();
	await verify();
});

test("card padding and UI scale change real geometry by the selected amounts and restore", async ({
	page,
}) => {
	await open(page, "Layout & text");

	const card = page.getByTestId("consumer-card");
	const roundness = page.getByRole("slider", {
		name: "Roundness",
		exact: true,
	});
	await roundness.focus();
	await page.keyboard.press("End");
	await expect(roundness).toHaveAttribute("aria-valuenow", "1.5");
	await expect(card).toHaveCSS("border-top-left-radius", "40px");
	await page.keyboard.press("ArrowRight");
	await expect(roundness).toHaveAttribute("aria-valuenow", "1.5");
	await page.keyboard.press("Home");
	await expect(roundness).toHaveAttribute("aria-valuenow", "0");
	await expect(card).toHaveCSS("border-top-left-radius", "16px");
	const spacing = page.getByRole("slider", {
		name: "Zoom (spacing)",
		exact: true,
	});
	const initialSpacing = Number(await spacing.getAttribute("aria-valuenow"));
	await spacing.focus();
	await page.keyboard.press("ArrowRight");
	await expect(spacing).toHaveAttribute(
		"aria-valuenow",
		String(Number((initialSpacing + 0.005).toFixed(3))),
	);
	const verifySpacing = () =>
		expect
			.poll(async () =>
				Number.parseFloat(
					await css(page.getByTestId("consumer-button"), "padding-left"),
				),
			)
			.toBeCloseTo((initialSpacing + 0.005) * 16 * 3, 2);
	await verifySpacing();
	const contrast = page.getByRole("slider", {
		name: "Muted contrast",
		exact: true,
	});
	const muted = page.getByTestId("consumer-muted");
	const beforeMuted = await css(muted, "color");
	await contrast.focus();
	await page.keyboard.press("End");
	await expect(contrast).toHaveAttribute("aria-valuenow", "100");
	await expect.poll(() => css(muted, "color")).not.toBe(beforeMuted);
	const selectedMuted = await css(muted, "color");
	const content = page.getByTestId("consumer-content");
	const padding = page.getByRole("slider", {
		name: "Card padding",
		exact: true,
	});
	const initial = Number(await padding.getAttribute("aria-valuenow"));
	await padding.focus();
	await page.keyboard.press("ArrowRight");
	await expect(padding).toHaveAttribute(
		"aria-valuenow",
		String(Number((initial + 0.02).toFixed(2))),
	);
	const verifyPadding = () =>
		expect
			.poll(async () => Number.parseFloat(await css(content, "padding-left")))
			.toBeCloseTo((initial + 0.02) * 16, 2);
	await verifyPadding();
	const button = page.getByTestId("consumer-button");
	const before = (await button.boundingBox())!;
	const scale = page.getByRole("slider", {
		name: "Scale (UI zoom)",
		exact: true,
	});
	const initialScale = Number(await scale.getAttribute("aria-valuenow"));
	await scale.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(async () => (await button.boundingBox())!.width / before.width)
		.toBeCloseTo((initialScale + 0.05) / initialScale, 2);
	const zoom = await css(page.locator("html"), "zoom");
	await page.reload();
	await expect.poll(() => css(page.locator("html"), "zoom")).toBe(zoom);
	await verifyPadding();
	await verifySpacing();
	await expect(card).toHaveCSS("border-top-left-radius", "16px");
	await expect.poll(() => css(muted, "color")).toBe(selectedMuted);
});

test("pointer preference changes enabled controls and preserves disabled controls after restart", async ({
	page,
}) => {
	await open(page, "Interface");
	const enabled = page.getByTestId("consumer-button"),
		disabled = page.getByTestId("consumer-disabled-button");
	const disabledCursor = await css(disabled, "cursor");
	await toggle(page, "pointer-cursor-toggle", true);
	await expect(enabled).toHaveCSS("cursor", "pointer");
	await expect(disabled).toHaveCSS("cursor", disabledCursor);
	await page.reload();
	await expect(enabled).toHaveCSS("cursor", "pointer");
	await open(page, "Interface");
	await toggle(page, "pointer-cursor-toggle", false);
	await expect(enabled).toHaveCSS("cursor", "default");
});

test("shadow preference removes and restores actual shared desktop chrome filters", async ({
	page,
}) => {
	const chrome = page
		.getByTestId("consumer-shell")
		.locator(".ryu-chrome-shadow");
	const original = await css(chrome, "filter");
	expect(original).not.toBe("none");
	await open(page, "Interface");
	await toggle(page, "chrome-shadows-toggle", false);
	await expect(chrome).toHaveCSS("filter", "none");
	await expect(chrome).toHaveCSS("box-shadow", "none");
	await page.reload();
	await expect(chrome).toHaveCSS("filter", "none");
	await open(page, "Interface");
	await toggle(page, "chrome-shadows-toggle", true);
	await expect.poll(() => css(chrome, "filter")).toBe(original);
});

test("blur and inverted backgrounds reach actual dialog and popup portals after restart", async ({
	page,
}) => {
	await open(page, "Interface");
	await toggle(page, "dialog-overlay-blur-toggle", true);
	await page
		.getByRole("button", { name: "Open consumer dialog", exact: true })
		.click();
	const overlay = page.locator('[data-slot="dialog-overlay"]');
	await expect(overlay).toBeVisible();
	await expect(overlay).toHaveCSS("backdrop-filter", "blur(8px)");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const popup = page.getByTestId("consumer-popup");
	await page
		.getByRole("button", { name: "Open consumer popup", exact: true })
		.click();
	const original = await rgba(popup);
	await page.keyboard.press("Escape");
	await toggle(page, "inverted-backgrounds-toggle", true);
	await page
		.getByRole("button", { name: "Open consumer popup", exact: true })
		.click();
	await expect
		.poll(async () => colorDelta(await rgba(popup), original))
		.toBeGreaterThan(1);
	const inverted = await rgba(popup);
	await page.keyboard.press("Escape");
	await page.reload();
	await page
		.getByRole("button", { name: "Open consumer popup", exact: true })
		.click();
	await expect
		.poll(async () => colorDelta(await rgba(popup), inverted))
		.toBeLessThanOrEqual(1);
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Open consumer dialog", exact: true })
		.click();
	await expect(overlay).toHaveCSS("backdrop-filter", "blur(8px)");
	await page.keyboard.press("Escape");
	await open(page, "Interface");
	await toggle(page, "dialog-overlay-blur-toggle", false);
	await page
		.getByRole("button", { name: "Open consumer dialog", exact: true })
		.click();
	await expect(overlay).toBeHidden();
	await expect(page.getByRole("dialog")).toBeVisible();
});

test("friendly labels preserve real model selection identity", async ({
	page,
}) => {
	await open(page, "Interface");
	await toggle(page, "friendly-names-toggle", true);
	const model = page.getByRole("button", { name: "Select model", exact: true });
	await expect(model).toContainText("Gemma 4");
	await expect(model).not.toContainText("Q4_K_M");
	await expect(page.getByTestId("selected-model")).toHaveText("gemma-id");
	await toggle(page, "friendly-names-toggle", false);
	await expect(model).toContainText("gemma-4-12B-it-Q4_K_M");
	await model.click();
	await page.getByRole("button", { name: "Opus", exact: true }).click();
	await expect(page.getByTestId("selected-model")).toHaveText("opus-id");
	await page.reload();
	await expect(model).toContainText("gemma-4-12B-it-Q4_K_M");
});

test("persisted master motion controls real conversation preview and title with OS override", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await open(page, "Motion & effects");
	const preview = page.getByTestId("consumer-preview"),
		live = preview.locator('[aria-live="polite"]');
	await expect(live).toBeVisible();
	await expect(live.locator(":scope > :not([aria-hidden])")).toContainText(
		"Running tests",
		{ timeout: 7000 },
	);
	await page
		.getByRole("button", { name: "Change consumer title", exact: true })
		.click();
	await expect(page.locator("[data-animated-title]")).toHaveAttribute(
		"data-animated-title-state",
		"transitioning",
	);
	await toggle(page, "animations-enabled-toggle", false);
	await expect(live).toHaveCount(0);
	await expect(preview).toHaveText("Reviewing files");
	await page
		.getByRole("button", { name: "Change consumer title", exact: true })
		.click();
	await expect(page.locator("[data-animated-title]")).toHaveAttribute(
		"data-animated-title-state",
		"settled",
	);
	await page.waitForTimeout(2700);
	await expect(preview).toHaveText("Reviewing files");
	await page.reload();
	await expect(live).toHaveCount(0);
	await open(page, "Motion & effects");
	await toggle(page, "animations-enabled-toggle", true);
	await expect(live).toBeVisible();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(live).toHaveCount(0);
	await expect(preview).toHaveText("Reviewing files");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:animations-enabled")),
		)
		.toBe("true");
});

// Expected to expose the current production gaps before the review-only patch.
test("selected chat width controls actual transcript content, composer and narrow viewport", async ({
	page,
}) => {
	await open(page, "Layout & text");
	const slider = page.getByRole("slider", { name: "Chat width", exact: true });
	const initial = Number(await slider.getAttribute("aria-valuenow"));
	await slider.focus();
	await page.keyboard.press("ArrowRight");
	const selected = initial + 10;
	await expect(slider).toHaveAttribute("aria-valuenow", String(selected));
	const column = page
		.getByTestId("consumer-chat")
		.locator('[data-slot="message-scroller-content"]');
	const verify = () =>
		expect
			.poll(async () =>
				column.evaluate((element) => {
					const style = getComputedStyle(element);
					return (
						element.getBoundingClientRect().width -
						parseFloat(style.paddingLeft) -
						parseFloat(style.paddingRight)
					);
				}),
			)
			.toBeCloseTo(selected, 1);
	const composer = page
		.getByTestId("consumer-chat")
		.locator(".consumer-composer > div");
	const verifyComposer = () =>
		expect
			.poll(async () => (await composer.boundingBox())!.width)
			.toBeCloseTo(selected, 1);
	await verify();
	await verifyComposer();
	await page
		.getByRole("button", { name: "Expand composer", exact: true })
		.click();
	await expect
		.poll(async () => (await composer.boundingBox())!.width)
		.toBeCloseTo(selected + 100, 1);
	await page
		.getByRole("button", { name: "Collapse composer", exact: true })
		.click();
	await verifyComposer();
	await page.reload();
	await verify();
	await verifyComposer();
	await page.setViewportSize({ width: 620, height: 1100 });
	await expect
		.poll(async () =>
			column.evaluate(
				(element) =>
					element.getBoundingClientRect().width <=
					element.parentElement!.getBoundingClientRect().width,
			),
		)
		.toBe(true);
	await expect
		.poll(async () => {
			const bounds = (await page.getByTestId("consumer-chat").boundingBox())!;
			const transcript = (await column.boundingBox())!;
			const input = (await composer.boundingBox())!;
			return (
				transcript.x >= bounds.x - 1 &&
				transcript.x + transcript.width <= bounds.x + bounds.width + 1 &&
				input.x >= bounds.x - 1 &&
				input.x + input.width <= bounds.x + bounds.width + 1
			);
		})
		.toBe(true);
});

test("streamed assistant words obey feature toggle, master motion, completion and OS override", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(STORY);
	await open(page, "Motion & effects");
	const chat = page.getByTestId("consumer-chat");
	const animated = chat.locator("[data-sd-animate]");
	const verifyChatMotion = async (enabled: boolean) => {
		// These flags control shipping Motion layout/transition props. Also assert
		// the actual InputBar effect below, rather than treating flags as sufficient.
		await expect
			.soft(chat.locator("[data-chat-motion]"))
			.toHaveAttribute("data-chat-motion", enabled ? "on" : "off");
		await expect
			.soft(chat.locator("[data-composer-motion]"))
			.toHaveAttribute("data-composer-motion", enabled ? "on" : "off");
		await page.getByTestId("turn-progress-steps").click();
		const popup = page.locator('[data-slot="popover-content"]').filter({
			has: page.getByText("Testing appearance motion", { exact: true }),
		});
		await expect(popup).toBeVisible();
		const spinner = popup
			.getByText("Testing appearance motion", { exact: true })
			.locator("..")
			.locator("svg");
		await expect(spinner).toHaveCount(1);
		await expect
			.soft(spinner)
			.toHaveCSS("animation-name", enabled ? "spin" : "none");
		if (enabled) {
			await expect
				.soft(spinner)
				.toHaveCSS("animation-iteration-count", "infinite");
			await expect.soft(spinner).toHaveCSS("animation-duration", "1s");
		}
		await page.keyboard.press("Escape");
		await expect(popup).toBeHidden();
	};
	await verifyChatMotion(false);
	await expect(animated).toHaveCount(0);
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await verifyChatMotion(true);
	await page
		.getByRole("button", { name: "Append real chat text", exact: true })
		.click();
	await expect(animated.first()).toBeVisible();
	await expect(animated.first()).toHaveCSS("animation-name", "sd-blurIn");
	await toggle(page, "stream-animation-toggle", false);
	await page
		.getByRole("button", { name: "Append real chat text", exact: true })
		.click();
	await expect(animated).toHaveCount(0);
	await expect(chat).toContainText("new streamed words new streamed words");
	await page.reload();
	await expect(animated).toHaveCount(0);
	await open(page, "Motion & effects");
	await toggle(page, "stream-animation-toggle", true);
	await page
		.getByRole("button", { name: "Append real chat text", exact: true })
		.click();
	await expect(animated.first()).toBeVisible();
	await toggle(page, "animations-enabled-toggle", false);
	await verifyChatMotion(false);
	await expect(animated).toHaveCount(0);
	await toggle(page, "animations-enabled-toggle", true);
	await verifyChatMotion(true);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await verifyChatMotion(false);
	await expect(animated).toHaveCount(0);
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await verifyChatMotion(true);
	await page
		.getByRole("button", { name: "Finish real chat stream", exact: true })
		.click();
	await expect(animated).toHaveCount(0);
	await expect(chat).toContainText("new streamed words");
});
