import path from "node:path";
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

test("proves live scroll cards and infinite canvas panes", async ({ page }) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
	// The full Chromium build requests /favicon.ico, which the harness does not
	// serve; answer it so that request is not a console error.
	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));

	await page.goto("/tab-views-proof.html");
	await expect(page.getByTestId("mode")).toHaveText("scroll");
	if (pageErrors.length > 0) {
		throw new Error(`Page errors: ${pageErrors.join(" | ")}`);
	}
	const cards = page.locator("[data-tab-view-card]");
	const track = page.getByTestId("scrollable-tabs-track");
	await expect(page.getByTestId("scrollable-tabs-view")).toBeVisible();
	await expect(cards).toHaveCount(5);
	await expect(page.getByTestId("active-tab")).toHaveText("tab-one");
	await expect(cards.first()).toHaveAttribute("data-focused", "true");

	await cards.nth(1).evaluate((element) =>
		element.scrollIntoView({
			behavior: "auto",
			block: "nearest",
			inline: "center",
		})
	);
	await expect
		.poll(() => page.getByTestId("active-tab").innerText())
		.toBe("tab-two");
	await expect(cards.nth(1)).toHaveAttribute("data-focused", "true");

	await cards.nth(2).evaluate((element) =>
		element.scrollIntoView({
			behavior: "auto",
			block: "nearest",
			inline: "center",
		})
	);
	await expect(page.getByTestId("active-tab")).toHaveText("tab-three");
	const [scrollWidth, clientWidth] = await track.evaluate((element) => [
		element.scrollWidth,
		element.clientWidth,
	]);
	expect(scrollWidth).toBeGreaterThan(clientWidth);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../test-results/tab-views-scroll-proof.png"
		),
		fullPage: false,
	});

	await page.getByTestId("show-canvas-view").click();
	const canvas = page.getByTestId("infinite-tabs-canvas");
	await expect(canvas).toBeVisible();
	await expect(canvas.locator('[data-canvas-region="Research"]')).toBeVisible();
	await expect(
		canvas.locator('[data-canvas-region="Output pair"]')
	).toBeVisible();
	const nodes = canvas.locator('[data-id^="tab:"]');
	await expect(nodes).toHaveCount(5);
	await expect(canvas.locator("[data-proof-route]")).toHaveCount(5);

	await canvas
		.locator('[data-tab-view-header="tab-two"] button')
		.first()
		.click();
	await expect(page.getByTestId("active-tab")).toHaveText("tab-two");

	const node = nodes.nth(1);
	const before = await node.boundingBox();
	if (!before) {
		throw new Error("Canvas node geometry was not available");
	}
	await page.mouse.move(
		before.x + before.width / 2,
		before.y + before.height / 2
	);
	await page.mouse.down();
	await page.mouse.move(
		before.x + before.width / 2 + 80,
		before.y + before.height / 2 + 30,
		{ steps: 8 }
	);
	await page.mouse.up();
	await expect
		.poll(async () => (await node.boundingBox())?.x ?? before.x)
		.toBeGreaterThan(before.x + 20);

	await canvas.getByRole("button", { name: "Fit all" }).click();
	await expect(canvas.locator("[data-proof-route]")).toHaveCount(5);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../test-results/tab-views-canvas-proof.png"
		),
		fullPage: false,
	});

	expect(consoleErrors).toEqual([]);
	expect(pageErrors).toEqual([]);
});
