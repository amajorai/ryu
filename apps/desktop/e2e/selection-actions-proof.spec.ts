import { expect, test } from "@playwright/test";

const STORY_URL = "/selection-actions-proof.html";

test("renders plugin-contributed selection actions and forwards selected text", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("selection-actions-proof")).toBeVisible();

	await page.evaluate(() => {
		const target = document.querySelector('[data-testid="selection-copy"]');
		if (!target) {
			throw new Error("selection proof target missing");
		}
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(target);
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	});

	// The annotate box opens straight away with the note field focused; the
	// actions sit underneath it instead of gating it.
	const note = page.getByTestId("selection-annotate-note");
	await expect(note).toBeVisible();
	await expect(note).toBeFocused();
	const toolbar = page.locator('[data-slot="selection-toolbar"]');
	await expect(toolbar).toBeVisible();
	await expect(toolbar.getByRole("button", { name: "Quote" })).toBeVisible();
	await expect(
		toolbar.getByRole("button", { name: "Ask in side chat" })
	).toBeVisible();
	await expect(toolbar.getByRole("button", { name: "Explain" })).toBeVisible();
	await expect(toolbar.locator('span[aria-hidden="true"]')).toHaveCount(2);

	await page.screenshot({
		path: test.info().outputPath("selection-actions-proof.png"),
		fullPage: true,
	});
	await toolbar.getByRole("button", { name: "Explain" }).click();
	await expect(page.getByTestId("selection-event")).toContainText("Explain");
	await expect(page.getByTestId("selection-event")).toContainText(
		"A side chat uses the active main model"
	);
});

test("a note typed into the annotate box rides along with the chosen action", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("selection-actions-proof")).toBeVisible();

	const select = () =>
		page.evaluate(() => {
			const target = document.querySelector('[data-testid="selection-copy"]');
			if (!target) {
				throw new Error("selection proof target missing");
			}
			const range = document.createRange();
			range.selectNodeContents(target);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});

	await select();
	const note = page.getByTestId("selection-annotate-note");
	await note.fill("Why the main model?");
	await page
		.locator('[data-slot="selection-toolbar"]')
		.getByRole("button", { name: "Ask in side chat" })
		.click();
	await expect(note).toHaveCount(0);
	await expect(page.getByTestId("selection-event")).toContainText(
		"Ask in side chat"
	);
	await expect(page.getByTestId("selection-event")).toContainText(
		"Why the main model?"
	);

	// Enter runs the primary action (Quote) with the note.
	await select();
	await note.fill("Agreed");
	await note.press("Enter");
	await expect(page.getByTestId("quote-event")).toContainText("Agreed");

	// Escape dismisses without running anything.
	await select();
	await expect(note).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(note).toHaveCount(0);
});
