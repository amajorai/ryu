import path from "node:path";
import { expect, test } from "@playwright/test";

test("discovered package installation guide describes authoritative lifecycle state", async ({
	page,
}) => {
	await page.goto("/docs/extend/develop/extensions/plugin-runtime", {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByRole("heading", { name: /^Plugin lifecycle/ })
		.scrollIntoViewIfNeeded();
	await expect(
		page.getByText("A discovered local package can be listed before", {
			exact: false,
		})
	).toBeVisible();
	await expect(
		page.getByText("An already installed package still", { exact: false })
	).toBeVisible();
	await page
		.getByText("A discovered local package can be listed before", {
			exact: false,
		})
		.scrollIntoViewIfNeeded();
	await expect(
		page.getByText("Hook host capabilities use the intersection", {
			exact: false,
		})
	).toBeVisible();
	await page.screenshot({
		fullPage: false,
		animations: "disabled",
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/discovered-package-lifecycle-completed.png"
		),
	});
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({
		fullPage: true,
		animations: "disabled",
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/discovered-package-install-guide-completed.png"
		),
	});
});

test("Marketplace guide explains readable package cards", async ({ page }) => {
	await page.goto("/docs/surfaces/desktop/user-guide/marketplace", {
		waitUntil: "domcontentloaded",
	});
	const copy = page.getByText("Package cards keep the package name", {
		exact: false,
	});
	await copy.scrollIntoViewIfNeeded();
	await expect(copy).toBeVisible();
	await page.screenshot({
		fullPage: false,
		animations: "disabled",
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/cards/public-guide-completed.png"
		),
	});
});

test.describe.configure({ timeout: 240_000 });
for (const name of [
	"writing-style",
	"llm-wiki",
	"security-scanner",
	"spider",
	"side-chats",
	"ego-browser",
	"recap",
]) {
	test(`${name} public guide renders completed runtime guidance`, async ({
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
		await page.goto(`/docs/plugins/${name}`, { waitUntil: "domcontentloaded" });
		if (name === "recap") {
			await page
				.getByRole("heading", { name: /^Model failure and retry/ })
				.scrollIntoViewIfNeeded();
			await expect(
				page.getByText("It does not forward the command to the main agent", {
					exact: false,
				})
			).toBeVisible();
			await page.screenshot({
				fullPage: false,
				animations: "disabled",
				path: path.resolve(
					import.meta.dirname,
					"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/recap-model-failure-guide-completed.png"
				),
			});
		} else if (name === "ego-browser") {
			await expect(
				page.getByRole("heading", { name: "Ego Browser", exact: true })
			).toBeVisible();
			await expect(
				page.getByText(
					"Caller input cannot change an operation tool into another action",
					{ exact: false }
				)
			).toBeVisible();
			await expect(
				page.getByText(
					"Tabs, snapshot and screenshot carry read-only effect metadata",
					{ exact: false }
				)
			).toBeVisible();
			await page.screenshot({
				fullPage: false,
				animations: "disabled",
				path: path.resolve(
					import.meta.dirname,
					"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/ego-browser-effects-completed.png"
				),
			});
		} else if (name === "spider") {
			await expect(
				page.getByRole("heading", { name: "Spider", exact: true })
			).toBeVisible();
			await expect(
				page.getByText(
					"Installing the CLI or changing egress settings does not remove this restriction",
					{ exact: false }
				)
			).toBeVisible();
		} else if (name === "side-chats") {
			await page
				.getByRole("heading", { name: /^Stop and dismiss/ })
				.scrollIntoViewIfNeeded();
			await expect(
				page.getByText("A late result cannot reopen a dismissed dialog", {
					exact: false,
				})
			).toBeVisible();
			await expect(
				page.getByText("Client cancellation does not guarantee", {
					exact: false,
				})
			).toBeVisible();
		} else {
			await page
				.getByRole("heading", { name: /^Bundled skill availability/ })
				.scrollIntoViewIfNeeded();
			await expect(
				page.getByText("A catalog entry alone does not supply skill files", {
					exact: false,
				})
			).toBeVisible();
			await expect(
				page.getByText("enable the plugin again to retry", { exact: false })
			).toBeVisible();
		}
		await page.mouse.move(12, 12);
		await page.evaluate(() => window.scrollTo(0, 0));
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await page.screenshot({
			fullPage: true,
			path: path.resolve(
				import.meta.dirname,
				`../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/${name}-guide-completed.png`
			),
			animations: "disabled",
		});
		expect(errors).toEqual([]);
	});
}
