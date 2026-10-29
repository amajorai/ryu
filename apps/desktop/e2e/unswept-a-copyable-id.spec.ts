import { expect, type Locator, type Page, test } from "@playwright/test";

// The REAL shared CopyableId in real Chromium with the app stylesheet: the id is
// blurred until its row is hovered or keyboard-focused, and the copy button is
// a native button operated from the keyboard into the real system clipboard.
const STORY_URL = "/unswept-a-copyable-id.html";
const ORG_ID = "org_01J9Z4WORKSPACEID";
const USER_ID = "user_01J9Z4ACCOUNTID";

function idText(page: Page, row: "org" | "user"): Locator {
	return page.locator(`[data-row="${row}"] code`);
}

function filterOf(locator: Locator): Promise<string> {
	return locator.evaluate((element) => getComputedStyle(element).filter);
}

async function clipboardText(page: Page): Promise<string> {
	return await page.evaluate(() => navigator.clipboard.readText());
}

test.beforeEach(async ({ page }) => {
	await page.goto(STORY_URL);
	await expect(idText(page, "org")).toHaveText(ORG_ID);
	await page.evaluate(() => navigator.clipboard.writeText("before"));
});

test("keyboard focus reveals only the focused id, Enter and Space copy it to the system clipboard", async ({
	page,
}) => {
	await expect.poll(() => filterOf(idText(page, "org"))).toBe("blur(5px)");
	await expect.poll(() => filterOf(idText(page, "user"))).toBe("blur(5px)");

	await page.getByRole("button", { name: "Before the ids" }).focus();
	await page.keyboard.press("Tab");
	const copyOrg = page.getByRole("button", { name: "Copy organization ID" });
	await expect(copyOrg).toBeFocused();
	await expect.poll(() => filterOf(idText(page, "org"))).toBe("blur(0px)");
	await expect.poll(() => filterOf(idText(page, "user"))).toBe("blur(5px)");

	await page.keyboard.press("Enter");
	await expect.poll(() => clipboardText(page)).toBe(ORG_ID);
	await expect(page.getByText("Copied organization ID")).toBeVisible();

	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", { name: "Copy user ID" })
	).toBeFocused();
	await expect.poll(() => filterOf(idText(page, "user"))).toBe("blur(0px)");
	await expect.poll(() => filterOf(idText(page, "org"))).toBe("blur(5px)");

	await page.keyboard.press("Space");
	await expect.poll(() => clipboardText(page)).toBe(USER_ID);
	await expect(page.getByText("Copied user ID")).toBeVisible();
});

test("hovering a row reveals its id and a tooltip with the full value without focusing it, and leaving blurs it again", async ({
	page,
}) => {
	await idText(page, "user").hover();
	await expect.poll(() => filterOf(idText(page, "user"))).toBe("blur(0px)");
	await expect.poll(() => filterOf(idText(page, "org"))).toBe("blur(5px)");
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
		USER_ID
	);
	await expect(
		page.getByRole("button", { name: "Copy user ID" })
	).not.toBeFocused();
	expect(await clipboardText(page)).toBe("before");

	await page.mouse.move(2, 2);
	await expect.poll(() => filterOf(idText(page, "user"))).toBe("blur(5px)");
});
