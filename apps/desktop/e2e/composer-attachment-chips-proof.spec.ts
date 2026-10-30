import { expect, type Locator, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

/** Viewport point just after `word` inside the composer's overlay text runs. */
async function pointAfterWord(scope: Locator, word: string) {
	const point = await scope.evaluate((root, target) => {
		for (const run of root.querySelectorAll("[data-composer-text-start]")) {
			const node = run.firstChild;
			const offset = node?.textContent?.indexOf(target) ?? -1;
			if (node && offset >= 0) {
				const range = document.createRange();
				range.setStart(node, offset);
				range.setEnd(node, offset + target.length);
				const rect = range.getBoundingClientRect();
				return { x: rect.right + 1, y: rect.top + rect.height / 2 };
			}
		}
		return null;
	}, word);
	if (!point) {
		throw new Error(`"${word}" is not rendered`);
	}
	return point;
}

async function dragTo(page: Page, from: Locator, to: { x: number; y: number }) {
	const source = await from.boundingBox();
	if (!source) {
		throw new Error("drag source is not laid out");
	}
	const startX = source.x + source.width / 2;
	const startY = source.y + source.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX + 8, startY, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await expect(
		page.locator("[data-slot='composer-token-drop-gap']")
	).toBeVisible();
	await page.mouse.up();
}

test("plain composer: attachments append chips that can be dragged and renumbered", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		// The bare Vite harness serves no favicon; that 404 is not the composer's.
		if (
			message.type() === "error" &&
			!message.location().url.endsWith("/favicon.ico")
		) {
			consoleErrors.push(`${message.location().url}: ${message.text()}`);
		}
	});
	await page.goto("/composer-attachment-chips-proof.html");
	const plain = page.getByTestId("plain");
	const draft = page.getByTestId("plain-draft");
	const composer = plain.getByRole("textbox", { name: "plain composer" });

	await plain.getByRole("button", { name: "Add image" }).click();
	await expect(draft).toHaveText("@image-1");
	await composer.click();
	await composer.press("End");
	await composer.pressSequentially("into face");
	await plain.getByRole("button", { name: "Add image" }).click();
	await plain.getByRole("button", { name: "Add text file" }).click();
	await expect(draft).toHaveText("@image-1 into face @image-2 @file-1");

	const chips = plain.locator("[data-composer-token-start]");
	await expect(chips).toHaveCount(3);
	// Drag `@image-2` to just after "into".
	await dragTo(page, chips.nth(1), await pointAfterWord(plain, "into"));
	await expect(draft).toHaveText(/^@image-1 into @image-2 face @file-1\s*$/);

	// Removing the first image drops its token and renumbers the survivor.
	const firstThumb = plain
		.locator("[data-slot='composer-attachments'] > *")
		.first();
	await firstThumb.hover();
	// The thumbnail also opens a preview; remove it through its own control.
	await firstThumb.getByRole("button", { name: /^Remove / }).click();
	await expect(draft).toHaveText(/^into @image-1 face @file-1\s*$/);

	await page.screenshot({ path: test.info().outputPath("plain.png") });
	expect(consoleErrors).toEqual([]);
});

test("rich composer: attachment chips render as mentions and move by drag", async ({
	page,
}) => {
	await page.goto("/composer-attachment-chips-proof.html");
	const rich = page.getByTestId("rich");
	await rich.getByRole("button", { name: "Add image" }).click();
	await rich.getByRole("button", { name: "Add image" }).click();
	await expect(page.getByTestId("rich-draft")).toHaveText(
		/^@image-1 @image-2\s*$/
	);
	const mentions = rich.locator("[data-slate-value]");
	await expect(mentions).toHaveCount(2);
	await expect(mentions.first()).toHaveAttribute("draggable", "true");

	// Drag `@image-1` past `@image-2`; the editor moves the void and pads it.
	const first = await mentions.first().boundingBox();
	const second = await mentions.nth(1).boundingBox();
	if (!(first && second)) {
		throw new Error("mentions are not laid out");
	}
	const startX = first.x + first.width / 2;
	const startY = first.y + first.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX + 10, startY, { steps: 5 });
	await page.mouse.move(second.x + second.width + 6, startY, { steps: 10 });
	await page.mouse.up();
	await expect(page.getByTestId("rich-draft")).toHaveText(
		/^@image-2\s*@image-1\s*$/
	);
	await page.screenshot({ path: test.info().outputPath("rich.png") });
});
