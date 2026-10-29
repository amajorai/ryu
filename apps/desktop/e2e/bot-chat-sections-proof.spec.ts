import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/bot-chat-sections-proof.html?reset=1";

function section(page: Page, id: string) {
	return page.getByTestId(`bot-chat-section-${id}`);
}

function chatRow(page: Page, title: string) {
	return page.locator('div[role="button"]', { hasText: title }).first();
}

async function sectionOrder(page: Page) {
	return page
		.locator('[data-testid^="bot-chat-section-"]')
		.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-subsection-key"))
		);
}

test("creates, assigns, reorders, sorts, and deletes local chat sections", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(section(page, "unorganized")).toBeVisible();
	await expect(chatRow(page, "Newer follow-up")).toBeVisible();

	await page.getByRole("button", { name: "New section" }).click();
	await page.getByRole("textbox", { name: "Section name" }).fill("Follow up");
	await page.getByRole("button", { name: "Create section" }).click();
	await expect(page.getByText("Follow up", { exact: true })).toBeVisible();

	const createdSection = page
		.locator('[data-testid^="bot-chat-section-section-"]')
		.first();
	await expect(createdSection).toBeVisible();
	const sectionId = await createdSection.getAttribute("data-subsection-key");
	expect(sectionId).toMatch(/^section-/);
	if (!sectionId) {
		return;
	}

	await createdSection
		.getByRole("button", { name: "Follow up options" })
		.click();
	await page.getByRole("menuitem", { name: "Rename section" }).click();
	await page
		.getByRole("textbox", { name: "Section name" })
		.fill("Client follow-up");
	await page.getByRole("button", { name: "Save name" }).click();
	await expect(
		page.getByText("Client follow-up", { exact: true })
	).toBeVisible();

	await chatRow(page, "Newer follow-up").dragTo(section(page, sectionId));
	await expect(section(page, sectionId)).toContainText("Newer follow-up");
	await expect(section(page, "unorganized")).not.toContainText(
		"Newer follow-up"
	);
	const sectionHeader = section(page, sectionId).locator(
		"button[draggable='true']"
	);
	await sectionHeader.click();
	await expect(section(page, sectionId)).not.toContainText("Newer follow-up");
	await sectionHeader.click();
	await expect(section(page, sectionId)).toContainText("Newer follow-up");

	const beforeReorder = await sectionOrder(page);
	await section(page, sectionId)
		.locator("button[draggable='true']")
		.first()
		.dragTo(
			section(page, "unorganized").locator("button[draggable='true']").first()
		);
	const afterReorder = await sectionOrder(page);
	expect(afterReorder.indexOf(sectionId)).toBeLessThan(
		afterReorder.indexOf("unorganized")
	);
	expect(beforeReorder).not.toEqual(afterReorder);

	await page.goto("/bot-chat-sections-proof.html");
	await expect(section(page, sectionId)).toBeVisible();
	expect(await sectionOrder(page)).toEqual(afterReorder);

	const unorganizedTitles = await section(page, "unorganized")
		.locator('div[role="button"]')
		.allTextContents();
	expect(unorganizedTitles[0]).toContain("Older follow-up");

	await section(page, sectionId)
		.getByRole("button", { name: "Client follow-up options" })
		.click();
	await page.getByRole("menuitem", { name: "Delete section" }).click();
	await expect(page.getByTestId(`bot-chat-section-${sectionId}`)).toHaveCount(
		0
	);
	await expect(section(page, "unorganized")).toContainText("Newer follow-up");
});

async function createSection(page: Page, name: string) {
	await page.getByRole("button", { name: "New section" }).click();
	await page.getByRole("textbox", { name: "Section name" }).fill(name);
	await page.getByRole("button", { name: "Create section" }).click();
	const created = page
		.locator('[data-testid^="bot-chat-section-section-"]')
		.filter({ hasText: name })
		.last();
	await expect(created).toBeVisible();
	const id = await created.getAttribute("data-subsection-key");
	expect(id).toMatch(/^section-/);
	return id ?? "";
}

function header(page: Page, id: string) {
	return section(page, id).locator("button[draggable='true']").first();
}

test("nests a section inside another by dropping on its header, then lifts it back out", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const work = await createSection(page, "Work");
	const clients = await createSection(page, "Clients");

	// Dropping on the middle of a header moves the section inside it.
	await header(page, clients).dragTo(header(page, work));
	await expect(
		page
			.getByTestId(`bot-chat-section-children-${work}`)
			.getByTestId(`bot-chat-section-${clients}`)
	).toBeVisible();

	// The nesting persists across reloads.
	await page.goto("/bot-chat-sections-proof.html");
	await expect(
		page
			.getByTestId(`bot-chat-section-children-${work}`)
			.getByTestId(`bot-chat-section-${clients}`)
	).toBeVisible();

	// A parent cannot be dropped into its own child.
	await header(page, work).dragTo(header(page, clients));
	await expect(
		page.getByTestId(`bot-chat-section-children-${clients}`)
	).toHaveCount(0);

	// The keyboard-reachable menu moves it back to the top level.
	await section(page, clients)
		.getByRole("button", { name: "Clients options" })
		.click();
	await page.getByRole("menuitem", { name: "Move section to" }).click();
	await page.getByRole("menuitem", { name: "Top level" }).click();
	await expect(
		page.getByTestId(`bot-chat-section-children-${work}`)
	).toHaveCount(0);
	await expect(section(page, clients)).toBeVisible();
});
