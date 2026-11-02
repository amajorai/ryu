import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

async function hidden(page: import("@playwright/test").Page, value: boolean) {
	await page.evaluate((value) => {
		Object.defineProperty(document, "hidden", { configurable: true, value });
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: value ? "hidden" : "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}, value);
}
test("content entrypoint pauses work, disposes resources and restarts cleanly", async ({
	page,
}) => {
	await page.clock.install();
	await page.goto("/content-lifetime-proof.html");
	const html = page.locator("html");
	await expect(page.locator("#ryu-ai-toolbar-root")).toHaveCount(1);
	await expect(html).toHaveAttribute("data-extracts", "1");
	await expect(html).toHaveAttribute("data-pushes", "1");
	await expect(html).toHaveAttribute("data-saves", "1");
	await hidden(page, true);
	await page.clock.fastForward(30_000);
	await expect(html).toHaveAttribute("data-extracts", "1");
	await hidden(page, false);
	await expect(html).toHaveAttribute("data-extracts", "2");
	await page.getByRole("button", { name: "Ask page", exact: true }).click();
	await expect(html).toHaveAttribute("data-asks", "1");
	await page
		.getByRole("button", { name: "Invalidate script", exact: true })
		.click();
	await expect(html).toHaveAttribute("data-settings-listeners", "0");
	await expect(html).toHaveAttribute("data-message-listeners", "0");
	await expect(page.locator("#ryu-ai-toolbar-root")).toHaveCount(0);
	await expect(page.locator("#ryu-extension-root")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Resolve answer", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Settings event", exact: true })
		.click();
	await page.evaluate(() =>
		document.querySelector("main")?.append(document.createElement("span"))
	);
	await page.clock.fastForward(30_000);
	await expect(html).toHaveAttribute("data-extracts", "3");
	await expect(page.locator("#ryu-extension-root")).toHaveCount(0);
	await expect(page.locator("#ryu-ai-toolbar-root")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Restart script", exact: true })
		.click();
	await expect(page.locator("#ryu-ai-toolbar-root")).toHaveCount(1);
	await expect(html).toHaveAttribute("data-extracts", "4");
	await expect(html).toHaveAttribute("data-settings-listeners", "2");
	await expect(html).toHaveAttribute("data-message-listeners", "1");
	await page.getByRole("button", { name: "Ask page", exact: true }).click();
	await page
		.getByRole("button", { name: "Resolve answer", exact: true })
		.click();
	await page.screenshot({
		path: proofEvidencePath("performance-sweep/content-lifetime-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});
test("late settings cannot restart an invalidated content script", async ({
	page,
}) => {
	await page.clock.install();
	await page.goto("/content-lifetime-proof.html?late");
	await page
		.getByRole("button", { name: "Invalidate script", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Release settings", exact: true })
		.click();
	await page.clock.fastForward(30_000);
	await expect(page.locator("html")).toHaveAttribute("data-extracts", "0");
	await expect(page.locator("html")).toHaveAttribute(
		"data-settings-listeners",
		"0"
	);
	await expect(page.locator("html")).toHaveAttribute(
		"data-message-listeners",
		"0"
	);
	await expect(page.locator("#ryu-ai-toolbar-root")).toHaveCount(0);
	await expect(page.locator("#ryu-extension-root")).toHaveCount(0);
});
