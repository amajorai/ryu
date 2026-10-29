import path from "node:path";
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });
test("Headroom public guide renders streaming and fail-open behavior", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		return (url.protocol !== "http:" && url.protocol !== "https:") ||
			url.hostname === "127.0.0.1"
			? route.continue()
			: route.abort();
	});
	await page.goto("/docs/plugins/headroom", { waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("heading", { name: "Headroom Compression", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("streaming and non-streaming", { exact: false }).last()
	).toBeVisible();
	const behavior = page.getByRole("heading", {
		name: /^Request behavior/,
	});
	await behavior.scrollIntoViewIfNeeded();
	await expect(
		page
			.getByText("Gateway sends the original messages", { exact: false })
			.last()
	).toBeVisible();
	await expect(
		page
			.getByText("disabling it clears that configuration", { exact: false })
			.last()
	).toBeVisible();
	await page.mouse.move(12, 12);
	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/headroom/headroom-guide-completed.png"
		),
		animations: "disabled",
	});
	expect(errors).toEqual([]);
});
