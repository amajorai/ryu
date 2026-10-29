import { expect, test } from "@playwright/test";

test("shows all four web search access modes in the Search layer", async ({
	page,
}, testInfo) => {
	await page.goto("/web-search-access-proof.html");
	await page.getByRole("button", { name: "Toolkits" }).click();
	await page.getByRole("menuitem", { name: /Search/ }).click();
	await page.getByRole("menuitem", { name: /Web search/ }).click();

	const modeOptions = page.getByRole("menuitemradio");
	await expect(modeOptions).toHaveCount(4);
	await expect(
		page.getByRole("menuitemradio", { name: /Don't allow web search/ })
	).toBeVisible();
	await expect(
		page.getByRole("menuitemradio", {
			name: /Use the selected provider's maintained search index/,
		})
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("menuitemradio", {
			name: /Allow indexed external web access/,
		})
	).toBeVisible();
	await expect(
		page.getByRole("menuitemradio", {
			name: /Allow unrestricted, current web access/,
		})
	).toBeVisible();

	await page.screenshot({
		path: testInfo.outputPath("web-search-access-proof.png"),
	});

	const indexedMode = page.getByRole("menuitemradio", {
		name: /Allow indexed external web access/,
	});
	await indexedMode.click();
	await expect(
		page.getByRole("menuitem", { name: /Web search Indexed/ })
	).toBeVisible();
	await expect(
		page.getByRole("menuitemradio", {
			name: /Allow indexed external web access/,
		})
	).toHaveAttribute("aria-checked", "true");
});

test.describe("panel surface (the expanded Computer dialog)", () => {
	const PANEL_URL = "/web-search-access-proof.html?surface=panel";

	async function openWebSearchPage(page: import("@playwright/test").Page) {
		await page.getByRole("button", { name: /^Search/ }).click();
		await page.getByRole("button", { name: /^Web search/ }).click();
	}

	test("lists four rows, marks the saved one and moves the mark on pick", async ({
		page,
	}, testInfo) => {
		await page.goto(PANEL_URL);
		await openWebSearchPage(page);

		await expect(page.getByRole("button", { name: "Disabled" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Cached" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Indexed" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Live" })).toBeVisible();
		const cached = page.getByRole("button", { name: "Cached" });
		await expect(cached).toHaveAttribute("aria-current", "true");
		await expect(cached.getByLabel("Selected")).toBeVisible();

		await page.screenshot({
			path: testInfo.outputPath("web-search-access-panel-proof.png"),
		});

		const indexed = page.getByRole("button", { name: "Indexed" });
		await indexed.click();
		await expect(indexed).toHaveAttribute("aria-current", "true");
		await expect(cached).not.toHaveAttribute("aria-current", "true");

		await page.getByRole("button", { name: "Back to Search" }).click();
		await expect(
			page.getByRole("button", { name: /^Web search\s*Indexed/ })
		).toBeVisible();
	});

	test("says when the saved setting cannot be loaded", async ({ page }) => {
		await page.goto(`${PANEL_URL}&fail=get`);
		await page.getByRole("button", { name: /^Search/ }).click();
		await expect(
			page.getByRole("button", { name: /^Web search\s*Unavailable/ })
		).toBeVisible();
		await page.getByRole("button", { name: /^Web search/ }).click();
		await expect(
			page.getByText("Couldn't load this computer's web search setting.")
		).toBeVisible();
	});

	test("says when a pick cannot be saved", async ({ page }) => {
		await page.goto(`${PANEL_URL}&fail=put`);
		await openWebSearchPage(page);
		await page.getByRole("button", { name: "Indexed" }).click();
		await expect(
			page.getByText("Couldn't save the web search setting.")
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Cached" })).toHaveAttribute(
			"aria-current",
			"true"
		);
	});
});
