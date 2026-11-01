import { expect, type FileChooser, test } from "@playwright/test";
import {
	choose,
	errors,
	ready,
	registerLanguageFixtureHooks,
} from "./language-settings-proof-helpers.ts";

registerLanguageFixtureHooks();

test("every Settings control is reached in order from the keyboard and operates without a pointer", async ({
	page,
	request,
}) => {
	// Chooser interception is enabled asynchronously when a listener is added,
	// so it is registered before any key press rather than raced against one.
	const choosers: FileChooser[] = [];
	page.on("filechooser", (chooser) => choosers.push(chooser));
	await ready(page);
	const before = await (await request.get("/__language-proof/receipts")).json();
	const focused = () =>
		page.evaluate(() => {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement) || active === document.body) {
				return null;
			}
			const kind = active.getAttribute("role") ?? active.tagName.toLowerCase();
			// A combobox is named by its shown value, not its decorative chevron.
			const name =
				active.getAttribute("aria-label") ??
				active.querySelector('[data-slot="select-value"]')?.textContent ??
				active.textContent?.trim() ??
				"";
			return `${kind}:${name}`;
		});
	// Walk the page from its start with Tab only.
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	});
	const exports = [
		...(await page.evaluate(() =>
			Array.from(
				document.querySelectorAll<HTMLButtonElement>(
					'button[aria-label^="Export "]'
				),
				(button) => `button:${button.getAttribute("aria-label")}`
			)
		)),
	];
	expect(exports).toContain("button:Export Window proof Spanish");
	expect(exports).toContain("button:Export Disabled French");
	const expected = [
		"button:Import",
		"combobox:Auto detect",
		...exports,
		"button:Marketplace",
		"input:Unsent language proof draft",
	];
	const visited: (string | null)[] = [];
	for (const _ of expected) {
		await page.keyboard.press("Tab");
		visited.push(await focused());
	}
	expect(visited).toEqual(expected);

	// The language picker is operated with keys alone: Tab reaches it, an arrow
	// key opens it on the saved choice, the arrows move the highlight, and Enter
	// saves and projects the highlighted language.
	const saved = () =>
		page.evaluate(() => ({
			mode: localStorage.getItem("ryu:language-mode"),
			pack: localStorage.getItem("ryu:language-pack"),
		}));
	expect(await saved()).toEqual({ mode: null, pack: null });
	// Shift+Tab walks back from the draft to Import through the same stops, and
	// Tab then reaches the picker.
	const backward: (string | null)[] = [];
	for (const _ of expected.slice(0, -1)) {
		await page.keyboard.press("Shift+Tab");
		backward.push(await focused());
	}
	expect(backward).toEqual(expected.slice(0, -1).reverse());
	await page.keyboard.press("Tab");
	const picker = page.getByRole("combobox");
	await expect(picker).toBeFocused();
	const listbox = page.getByRole("listbox");
	const highlighted = listbox.locator('[role="option"][data-highlighted]');
	await page.keyboard.press("ArrowDown");
	await expect(listbox).toBeVisible();
	const options = (await listbox.getByRole("option").allTextContents()).map(
		(option) => option.trim()
	);
	expect(options.slice(0, 2)).toEqual(["Auto detect", "English"]);
	const spanish = options.indexOf("Window proof Spanish");
	expect(spanish).toBeGreaterThan(1);
	await expect(highlighted).toHaveText("Auto detect");
	for (const option of options.slice(1, spanish + 1)) {
		await page.keyboard.press("ArrowDown");
		await expect(highlighted).toHaveText(option);
	}
	// Nothing is saved or projected while the highlight only moves.
	expect(await saved()).toEqual({ mode: null, pack: null });
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
	await expect(picker).toBeFocused();
	await expect(picker).toContainText("Window proof Spanish");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	expect(await saved()).toEqual({ mode: "fixed", pack: "coverage/window" });
	// ArrowUp opens it on the saved pack; the arrows walk back to Auto detect.
	await page.keyboard.press("ArrowUp");
	await expect(listbox).toBeVisible();
	await expect(highlighted).toHaveText("Window proof Spanish");
	// The Spanish pack is now active, and keyed messages it leaves out fall
	// back to the built-in Spanish catalog (48c3b467bf, "catalog fallback for
	// keyed messages"), so the reopened list names the English row in Spanish.
	// The label can land a frame after the list opens, so it is awaited before
	// the walk reads the rows. Pack names stay as published, in the same order.
	const rows = listbox.getByRole("option");
	await expect(rows.nth(1)).toHaveText("Inglés");
	const localized = (await rows.allTextContents()).map((option) =>
		option.trim()
	);
	expect(localized.slice(2)).toEqual(options.slice(2));
	for (const option of localized.slice(0, spanish).reverse()) {
		await page.keyboard.press("ArrowUp");
		await expect(highlighted).toHaveText(option);
	}
	await page.keyboard.press("Enter");
	await expect(listbox).toBeHidden();
	await expect(picker).toBeFocused();
	await expect(picker).toContainText("Auto detect");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
	expect(await saved()).toEqual({ mode: "auto", pack: null });

	// Enter on Import opens the archive chooser for exactly one portable archive.
	await page.getByRole("button", { name: "Import", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => choosers.length).toBe(1);
	expect(choosers[0]!.isMultiple()).toBe(false);
	expect(await choosers[0]!.element().getAttribute("accept")).toBe(
		".ryupack,application/zip"
	);
	// Space on an Export button downloads that pack's archive.
	await page
		.getByRole("button", { name: "Export Window proof Spanish", exact: true })
		.focus();
	const download = page.waitForEvent("download");
	await page.keyboard.press("Space");
	expect((await download).suggestedFilename()).toBe(
		"window-proof-spanish-1.0.0.ryupack"
	);
	// Enter on Marketplace opens the Marketplace route in the same window.
	await page.getByRole("button", { name: "Marketplace", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("language-location")).toHaveText(
		"/marketplace"
	);
	const after = await (await request.get("/__language-proof/receipts")).json();
	expect(after.packs).toEqual(before.packs);
	expect(after.importWrites).toBe(0);
	expect(after.enableWrites).toBe(0);
	expect(errors.get(page)).toEqual([]);
});

test("content-identical catalog refreshes leave <html> and style untouched in a real browser, while a real choice still updates them", async ({
	page,
	request,
}) => {
	await ready(page);
	await page.evaluate(() => {
		const records: string[] = [];
		Reflect.set(window, "__languageRootMutations", records);
		new MutationObserver((list) => {
			for (const record of list) {
				records.push(record.attributeName ?? "");
			}
		}).observe(document.documentElement, {
			attributeFilter: ["dir", "lang", "style"],
			attributes: true,
		});
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	const styleRecalcs = async () => {
		const { metrics } = await cdp.send("Performance.getMetrics");
		return metrics.find((metric) => metric.name === "RecalcStyleCount")?.value;
	};
	// Two frames plus a timer turn: every effect, rescan and style pass of the
	// last committed refresh has run.
	const quiet = () =>
		page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => setTimeout(resolve, 100))
					)
				)
		);
	await quiet();
	const readsBefore = (
		await (await request.get("/__language-proof/receipts")).json()
	).catalogReads;
	const recalcsBefore = await styleRecalcs();
	for (let refresh = 0; refresh < 3; refresh += 1) {
		const read = page.waitForResponse((response) =>
			response.url().endsWith("/api/language-packs/installed")
		);
		await page.evaluate(() =>
			window.dispatchEvent(new Event("ryu:language-packs-changed"))
		);
		await (await read).finished();
		await quiet();
	}
	const recalcsAfter = await styleRecalcs();
	const receipts = await (
		await request.get("/__language-proof/receipts")
	).json();
	expect(receipts.catalogReads).toBe(readsBefore + 3);
	expect(
		await page.evaluate(() => Reflect.get(window, "__languageRootMutations"))
	).toEqual([]);
	expect(recalcsAfter).toBe(recalcsBefore);
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"en-US:Install"
	);
	// The same observers see a real choice: one publication rewrites <html>.
	await choose(page, "Window proof Spanish");
	await expect(page.getByTestId("language-consumer")).toHaveText(
		"es:Instalar entre ventanas"
	);
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	expect(
		await page.evaluate(() => Reflect.get(window, "__languageRootMutations"))
	).toContain("lang");
	expect(await styleRecalcs()).toBeGreaterThan(recalcsAfter!);
	expect(errors.get(page)).toEqual([]);
});
