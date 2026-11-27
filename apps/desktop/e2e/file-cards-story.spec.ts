// Real-browser spec for the file cards story
// (`e2e/harness/file-cards-story.html`): the transcript's file card, the
// inline attachment card, created files with their previews, and the Download
// button on the artifact card.
//
// The unit tests cover the rules and the states. This spec covers what only a
// browser shows: that Download really starts a download under a bare file
// name with the right bytes, that an image and a PDF really paint, and that
// the cards keep their shape in both themes at desktop and phone width. It
// also writes the before and after screenshots a reviewer looks at.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Cold Vite compiles the card's module graph on first navigation.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const STORY_URL = "/file-cards-story.html";
const SHOTS_DIR = process.env.RYU_FILE_CARD_SHOTS ?? "test-results/file-cards";

const VIEWPORTS = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
] as const;
const THEMES = ["light", "dark"] as const;
const SHOT_PANES = [
	"ready",
	"downloading",
	"downloaded",
	"failed",
	"unavailable",
	"long-name",
	"rtl",
	"attachment",
	"image",
	"pdf",
	"office",
	"artifact",
] as const;
/** The panes the before page has: what the chat drew for the same parts. */
const BEFORE_PANES = [
	"attachment",
	"image",
	"pdf",
	"office",
	"artifact",
] as const;
const CARD_PANES = [
	"ready",
	"downloading",
	"downloaded",
	"failed",
	"unavailable",
	"long-name",
	"rtl",
	"path-title",
	"attachment",
	"image",
	"pdf",
	"office",
] as const;

function pane(page: Page, name: string): Locator {
	return page.getByTestId(`story-${name}`);
}

function card(page: Page, name: string): Locator {
	return pane(page, name).getByTestId("file-card");
}

async function openStory(
	page: Page,
	theme: "dark" | "light" = "light",
	before = false
) {
	await page.goto(`${STORY_URL}?theme=${theme}${before ? "&before=1" : ""}`, {
		waitUntil: "domcontentloaded",
	});
	if (before) {
		await expect(page.getByTestId("story-mode")).toHaveText(
			"Files in the chat, before",
			{ timeout: 120_000 }
		);
		await expect(pane(page, "artifact")).toBeVisible();
		return;
	}
	await expect(card(page, "ready")).toBeVisible({ timeout: 120_000 });
	await expect(card(page, "office")).toBeVisible({ timeout: 120_000 });
}

/** Click Download in a pane and return the browser download it starts. */
async function downloadFrom(page: Page, button: Locator) {
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		button.click(),
	]);
	const file = await download.path();
	return {
		bytes: readFileSync(file),
		name: download.suggestedFilename(),
	};
}

async function imagePainted(page: Page) {
	const image = pane(page, "image").getByTestId("file-preview-image");
	await expect(image).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			() =>
				image
					.locator("img")
					.evaluate((element: HTMLImageElement) => element.naturalWidth),
			{ timeout: 30_000 }
		)
		.toBe(640);
}

async function pdfPainted(page: Page) {
	const canvas = pane(page, "pdf").locator("canvas");
	await expect(canvas).toBeVisible({ timeout: 60_000 });
	// A mounted canvas can still be blank while the PDF worker is loading. Wait
	// for the story page's black block to reach the canvas.
	await expect
		.poll(
			() =>
				canvas.evaluate((element: HTMLCanvasElement) => {
					const context = element.getContext("2d");
					if (!context || element.width === 0) {
						return 0;
					}
					const pixels = context.getImageData(
						0,
						0,
						element.width,
						element.height
					).data;
					let dark = 0;
					for (let index = 0; index < pixels.length; index += 4) {
						if (
							pixels[index] < 60 &&
							pixels[index + 1] < 60 &&
							pixels[index + 2] < 60 &&
							pixels[index + 3] > 0
						) {
							dark += 1;
						}
					}
					return dark;
				}),
			{ timeout: 60_000 }
		)
		.toBeGreaterThan(1000);
}

test("a file card shows the name, the type and the size, and Download saves the file", async ({
	page,
}) => {
	await openStory(page);
	const ready = card(page, "ready");
	await expect(ready).toHaveAttribute("data-state", "ready");
	await expect(ready.getByTestId("file-card-name")).toHaveText(
		"Q3 board report.pdf"
	);
	await expect(ready.getByTestId("file-card-type")).toHaveText("PDF");
	await expect(ready.getByTestId("file-card-size")).toHaveText("1.2 MB");

	const saved = await downloadFrom(
		page,
		ready.getByTestId("file-card-download")
	);
	expect(saved.name).toBe("Q3 board report.pdf");
	expect(saved.bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
	await expect(ready).toHaveAttribute("data-state", "downloaded");
	await expect(ready.getByTestId("file-card-status")).toHaveText("Downloaded");

	await ready.getByTestId("file-card-open").click();
	await expect(page.getByTestId("story-log")).toContainText(
		"open Q3 board report"
	);
});

test("a title that is a path is saved under a bare file name", async ({
	page,
}) => {
	await openStory(page);
	const saved = await downloadFrom(
		page,
		card(page, "path-title").getByTestId("file-card-download")
	);
	expect(saved.name).toBe("authorized_keys.txt");
	expect(saved.name).not.toMatch(/[\\/]|\.\./);
});

test("downloading, failed and unavailable are shown as states", async ({
	page,
}) => {
	await openStory(page);

	const downloading = card(page, "downloading");
	await downloading.getByTestId("file-card-download").click();
	await expect(downloading).toHaveAttribute("data-state", "downloading");
	await expect(downloading.getByTestId("file-card-download")).toBeDisabled();
	await expect(downloading.getByTestId("file-card-status")).toHaveText(
		"Downloading…"
	);

	const failed = card(page, "failed");
	await failed.getByTestId("file-card-download").click();
	await expect(failed).toHaveAttribute("data-state", "failed");
	await expect(failed.getByTestId("file-card-status")).toHaveText(
		"Could not read this file"
	);
	await expect(failed.getByTestId("file-card-download")).toHaveText("Retry");
	await expect(failed.getByTestId("file-card-download")).toBeEnabled();

	const unavailable = card(page, "unavailable");
	await expect(unavailable).toHaveAttribute("data-state", "unavailable");
	await expect(unavailable.getByTestId("file-card-download")).toBeDisabled();
	await expect(unavailable.getByTestId("file-card-status")).toHaveText(
		"File not found"
	);
});

test("an inline attachment downloads its own bytes and opens in the panel", async ({
	page,
}) => {
	await openStory(page);
	const attachment = card(page, "attachment");
	await expect(attachment.getByTestId("file-card-name")).toHaveText(
		"numbers.csv"
	);
	await expect(attachment.getByTestId("file-card-type")).toHaveText("CSV");
	await expect(attachment.getByTestId("file-card-size")).toHaveText("7 B");

	const saved = await downloadFrom(
		page,
		attachment.getByTestId("file-card-download")
	);
	expect(saved.name).toBe("numbers.csv");
	expect(saved.bytes.toString("utf8")).toBe("a,b\n1,2");

	await attachment.getByTestId("file-card-open").click();
	await expect(page.getByTestId("story-log")).toContainText(
		"openInPanel numbers.csv"
	);
});

test("a created image and a created PDF preview inline", async ({ page }) => {
	await openStory(page);
	await imagePainted(page);
	await pdfPainted(page);
	// A picture has no viewer tab, a PDF has one.
	await expect(card(page, "image").getByTestId("file-card-open")).toHaveCount(
		0
	);
	await card(page, "pdf").getByTestId("file-card-open").click();
	await expect(page.getByTestId("story-log")).toContainText(
		"openFile Quarterly report.pdf"
	);
	const saved = await downloadFrom(
		page,
		card(page, "image").getByTestId("file-card-download")
	);
	expect(saved.name).toBe("Weekly signups.png");
	// The PNG signature: the bytes are the stored file, not a re-encoding.
	expect(saved.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
});

test("a created office file is a card with Download and Open", async ({
	page,
}) => {
	await openStory(page);
	const office = card(page, "office");
	await expect(office.getByTestId("file-card-name")).toHaveText(
		"Offer letter.docx"
	);
	await expect(office.getByTestId("file-card-type")).toHaveText("DOCX");
	await expect(office.getByTestId("file-card-size")).toHaveText("47.1 KB");
	await expect(
		pane(page, "office").getByTestId("file-preview-image")
	).toHaveCount(0);

	await office.getByTestId("file-card-open").click();
	await expect(page.getByTestId("story-log")).toContainText(
		"openFile Offer letter.docx"
	);
	const saved = await downloadFrom(
		page,
		office.getByTestId("file-card-download")
	);
	expect(saved.name).toBe("Offer letter.docx");
	expect(saved.bytes.toString("utf8")).toBe("PK story docx");
});

test("the artifact card has a Download button next to its Open group", async ({
	page,
}) => {
	await openStory(page);
	const artifact = pane(page, "artifact");
	// The Open group keeps its two buttons; Download sits beside it.
	const group = artifact.getByRole("group", { name: "Artifact actions" });
	await expect(group.locator('[data-slot="button"]')).toHaveCount(2);

	const saved = await downloadFrom(
		page,
		artifact.getByTestId("artifact-download")
	);
	expect(saved.name).toBe("Signup funnel.html");
	expect(saved.bytes.toString("utf8")).toContain("Signup funnel");
});

test("no card grows wider than a phone column", async ({ page }) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await openStory(page);
	await imagePainted(page);
	await pdfPainted(page);
	for (const name of CARD_PANES) {
		const box = await card(page, name).boundingBox();
		if (!box) {
			throw new Error(`${name} card is not laid out`);
		}
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		// The name is cut with an ellipsis inside the card, never pushed out.
		const nameBox = await card(page, name)
			.getByTestId("file-card-name")
			.boundingBox();
		if (!nameBox) {
			throw new Error(`${name} card has no name`);
		}
		expect(nameBox.x).toBeGreaterThanOrEqual(box.x);
		expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(box.x + box.width);
	}
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("screenshots before and after, both themes, desktop and phone", async ({
	page,
}) => {
	mkdirSync(SHOTS_DIR, { recursive: true });
	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({
			height: viewport.height,
			width: viewport.width,
		});
		for (const theme of THEMES) {
			// Before: the same parts as the chat drew them before the file card.
			await openStory(page, theme, true);
			await expect(page.getByTestId("file-card")).toHaveCount(0);
			await expect(page.getByTestId("artifact-download").first()).toBeHidden();
			await page.evaluate(async () => {
				await document.fonts.ready;
			});
			// The old cards have no ready mark. Their reads are in memory, so a
			// short wait is enough for the three reads and the page frame.
			await page.waitForTimeout(1500);
			for (const name of BEFORE_PANES) {
				await pane(page, name).screenshot({
					path: path.join(
						SHOTS_DIR,
						`before-${name}-${theme}-${viewport.name}.png`
					),
				});
			}
			await page.screenshot({
				fullPage: true,
				path: path.join(SHOTS_DIR, `before-all-${theme}-${viewport.name}.png`),
			});

			// After: every state of the file card, and the same parts as cards.
			await openStory(page, theme);
			await card(page, "downloading").getByTestId("file-card-download").click();
			await card(page, "failed").getByTestId("file-card-download").click();
			await downloadFrom(
				page,
				card(page, "downloaded").getByTestId("file-card-download")
			);
			await expect(card(page, "downloaded")).toHaveAttribute(
				"data-state",
				"downloaded"
			);
			await expect(card(page, "failed")).toHaveAttribute(
				"data-state",
				"failed"
			);
			await imagePainted(page);
			await pdfPainted(page);
			await page.evaluate(async () => {
				await document.fonts.ready;
			});
			for (const name of SHOT_PANES) {
				await pane(page, name).screenshot({
					path: path.join(
						SHOTS_DIR,
						`after-${name}-${theme}-${viewport.name}.png`
					),
				});
			}
			await page.screenshot({
				fullPage: true,
				path: path.join(SHOTS_DIR, `after-all-${theme}-${viewport.name}.png`),
			});
		}
	}
});
