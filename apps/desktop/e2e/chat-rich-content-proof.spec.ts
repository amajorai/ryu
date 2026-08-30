import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

const STORY_URL = "/chat-rich-content-proof.html";

function viewport(page: import("@playwright/test").Page) {
	return page.locator('[data-slot="message-scroller-viewport"]');
}

test("renders unlimited attachments, agent images, tables, and Mermaid controls", async ({
	page,
}) => {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });

	const user = page.locator('[data-message-id="rich-user"]');
	await expect(user.locator('[data-slot="message-attachments"]')).toBeVisible();
	await expect(user.getByTestId("message-image-attachment")).toHaveCount(6);
	await expect(user).toContainText("Startup Runway v2.0.pdf");
	await expect(user).toContainText(
		"Startup_Runway_Weekly_Template_v2_Original.docx"
	);
	const userTable = user
		.locator(".an-md-table")
		.filter({ hasText: "Runway brief" })
		.first();
	await expect(userTable).toBeVisible();
	await expect(userTable).toContainText("Runway brief");
	await expect(userTable.locator("thead th")).toHaveCount(3);
	const userTableWrapper = userTable.locator("xpath=../..");
	const userTableExpand = userTableWrapper.getByTestId("markdown-table-expand");
	await expect(userTableExpand).toBeVisible();
	await userTable.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: "test-results/user-markdown-table-inline-proof.png",
	});
	await userTableExpand.click();
	const userTableDialog = page.getByRole("dialog");
	await expect(userTableDialog).toContainText("Runway brief");
	await expect(userTableDialog.locator("thead th")).toHaveCount(3);
	await page.screenshot({
		path: "test-results/user-markdown-table-expanded-proof.png",
	});
	await userTableDialog.getByRole("button", { name: "Close" }).click();
	await expect(userTableDialog).toHaveCount(0);
	await expect(
		user.locator('[data-slot="message-attachments"] svg.text-red-500')
	).toHaveCount(1);
	await expect(
		user.locator('[data-slot="message-attachments"] svg.text-blue-600')
	).toHaveCount(1);
	const composerAttachments = page.locator(
		'[data-slot="composer-attachments"]'
	);
	await expect(composerAttachments).toBeVisible();
	await expect(composerAttachments.locator("img")).toHaveCount(6);
	const composerTile = await composerAttachments
		.locator("img")
		.first()
		.boundingBox();
	expect(composerTile).not.toBeNull();
	if (composerTile) {
		expect(composerTile.width).toBeGreaterThanOrEqual(80);
		expect(composerTile.height).toBeGreaterThanOrEqual(80);
	}
	const userImage = user.getByRole("button", { name: "Open brief-cover.svg" });
	await userImage.scrollIntoViewIfNeeded();
	await userImage.click();
	const attachmentLightbox = page.getByRole("dialog");
	await expect(attachmentLightbox).toBeVisible();
	await expect(
		attachmentLightbox.getByText("1 / 6", { exact: true })
	).toBeVisible();
	await expect(
		attachmentLightbox.getByRole("link", {
			name: "Download brief-cover.svg",
		})
	).toHaveAttribute("download", "brief-cover.svg");
	await attachmentLightbox.getByRole("button", { name: "Close" }).click();
	await expect(attachmentLightbox).toHaveCount(0);

	const scroller = viewport(page);
	await expect(page.locator('[data-streamdown="mermaid-block"]')).toBeVisible({
		timeout: 60_000,
	});
	await expect(
		page.locator(
			'[data-streamdown="mermaid-block"] button[aria-label="Open Mermaid diagram"] svg'
		)
	).toBeVisible({ timeout: 60_000 });
	await expect(page.locator(".an-md-table").first()).toBeVisible();
	await expect(page.getByTestId("mermaid-expand")).toBeVisible();
	await page.getByTestId("mermaid-expand").click();
	const diagramLightbox = page.getByRole("dialog");
	await expect(diagramLightbox).toBeVisible();
	await expect(
		diagramLightbox.getByRole("link", { name: "Download diagram.svg" })
	).toHaveAttribute("download", "diagram.svg");
	await diagramLightbox.getByRole("button", { name: "Close" }).click();
	await expect(diagramLightbox).toHaveCount(0);

	await page.getByTestId("markdown-table-copy").last().click();
	const tableMenu = page.getByRole("menu").last();
	await expect(
		tableMenu.getByRole("menuitem", { name: "Copy as Markdown" })
	).toBeVisible();
	await expect(
		tableMenu.getByRole("menuitem", { name: "Copy as CSV" })
	).toBeVisible();
	await expect(
		tableMenu.getByRole("menuitem", { name: "Copy as TSV" })
	).toBeVisible();
	await expect(
		tableMenu.getByRole("menuitem", { name: "Copy as PNG" })
	).toBeVisible();
	await tableMenu.getByRole("menuitem", { name: "Copy as PNG" }).click();
	await expect
		.poll(async () =>
			page.evaluate(async () => {
				const items = await navigator.clipboard.read();
				return items[0]?.types ?? [];
			})
		)
		.toContain("image/png");
	await page.keyboard.press("Escape");
	await page.getByTestId("markdown-table-copy").last().click();
	const markdownMenu = page.getByRole("menu").last();
	await markdownMenu
		.getByRole("menuitem", { name: "Copy as Markdown" })
		.click();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toContain("| Source | Use in deck | Status |");
	await page.keyboard.press("Escape");

	await page.getByTestId("mermaid-copy").click();
	const diagramMenu = page.getByRole("menu").last();
	await expect(
		diagramMenu.getByRole("menuitem", { name: "Copy as Mermaid" })
	).toBeVisible();
	await expect(
		diagramMenu.getByRole("menuitem", { name: "Copy as SVG" })
	).toBeVisible();
	await expect(
		diagramMenu.getByRole("menuitem", { name: "Copy as PNG" })
	).toBeVisible();
	await diagramMenu.getByRole("menuitem", { name: "Copy as SVG" }).click();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toContain("<svg");

	const markdownImage = page.getByRole("button", {
		name: "Open Agent visual reference",
	});
	await markdownImage.scrollIntoViewIfNeeded();
	await expect(markdownImage).toBeVisible();
	await markdownImage.click();
	const lightbox = page.getByRole("dialog");
	await expect(lightbox).toBeVisible();
	await expect(
		lightbox.getByRole("link", { name: "Download Agent visual reference" })
	).toHaveAttribute("download", "Agent visual reference");
	const zoom = lightbox.locator('[aria-live="polite"]');
	await expect(zoom).toHaveText("100%");
	await page.mouse.move(640, 360);
	await page.mouse.wheel(0, -360);
	await expect(zoom).not.toHaveText("100%");
	await page.screenshot({
		path: "test-results/chat-rich-content-lightbox-proof.png",
	});
	await lightbox.getByRole("button", { name: "Close" }).click();
	await expect(lightbox).toHaveCount(0);

	await scroller.evaluate((element) => {
		element.scrollTop = 0;
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await page.screenshot({
		path: "test-results/chat-rich-content-attachments-proof.png",
	});

	await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await page.screenshot({ path: "test-results/chat-rich-content-proof.png" });
});
