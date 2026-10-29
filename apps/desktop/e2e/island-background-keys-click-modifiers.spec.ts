import { expect, type Locator, type Page, test } from "@playwright/test";
import { QUICK_PREVIEW_HOLD_MS } from "../src/hooks/useModifierClickHold.ts";
import type { ClickModifierProofState } from "./harness/island-background-keys-click-modifiers.tsx";

// Settings → Keyboard Shortcuts "Quick reply click modifier" and "Quick
// preview click modifier", proven at their consumer: the REAL sidebar ChatRow
// mounted beside the REAL tab (harness/island-background-keys-click-modifiers).
// The page clock runs the click-and-hold delay, so no assertion depends on how
// fast the host is.
const STORY_URL = "/island-background-keys-click-modifiers.html";
const QUICK_REPLY_DESCRIPTION =
	"Hold this modifier while clicking a chat in the sidebar to open its floating quick-reply bar.";
const QUICK_PREVIEW_DESCRIPTION =
	"Hold this modifier while clicking and holding a chat in the sidebar to preview its messages without opening it.";

type Modifier = "Alt" | "Control" | "Shift";

function row(page: Page): Locator {
	return page.getByTestId("sidebar-chat-row-conv-click-modifiers");
}

function quickReplyTrigger(page: Page): Locator {
	return page.getByRole("combobox", { name: "Quick reply click modifier" });
}

function quickPreviewTrigger(page: Page): Locator {
	return page.getByRole("combobox", { name: "Quick preview click modifier" });
}

/** The choice a Select trigger shows, without its chevron. */
function shown(trigger: Locator): Locator {
	return trigger.locator('[data-slot="select-value"]');
}

async function counts(page: Page) {
	const read = async (testId: string) =>
		Number(await page.getByTestId(testId).textContent());
	return {
		previews: await read("quick-preview-count"),
		quickReplies: await read("quick-reply-count"),
		selections: await read("selection-count"),
	};
}

async function chooseOption(page: Page, trigger: Locator, label: string) {
	await trigger.click();
	const listboxId = await trigger.getAttribute("aria-controls");
	const listbox = listboxId
		? page.locator(`[id="${listboxId}"]`)
		: page.getByRole("listbox").last();
	await listbox.getByRole("option", { exact: true, name: label }).click();
	await expect(listbox).toBeHidden();
}

async function modifiedClick(page: Page, modifier: Modifier) {
	await row(page).click({ force: true, modifiers: [modifier] });
}

/** Press and hold the row with a modifier for the full quick-preview delay. */
async function modifiedHold(page: Page, modifier: Modifier) {
	const bounds = await row(page).boundingBox();
	if (!bounds) {
		throw new Error("Chat row has no layout box");
	}
	await page.mouse.move(
		bounds.x + bounds.width / 2,
		bounds.y + bounds.height / 2
	);
	await page.keyboard.down(modifier);
	await page.mouse.down();
	await page.clock.runFor(QUICK_PREVIEW_HOLD_MS + 50);
	await page.mouse.up();
	await page.keyboard.up(modifier);
}

async function expectCounts(
	page: Page,
	expected: { previews: number; quickReplies: number; selections: number }
) {
	await expect.poll(() => counts(page)).toEqual(expected);
}

test.describe.configure({ timeout: 90_000 });

test("Quick reply and Quick preview click modifiers decide what a modified click or hold on a sidebar chat opens, and survive a reload", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.clock.install();
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(row(page)).toBeVisible();

	// Defaults: Alt / Option replies, Shift-hold previews, a plain click opens.
	await expect(shown(quickReplyTrigger(page))).toHaveText("Alt / Option");
	await expect(shown(quickPreviewTrigger(page))).toHaveText("Shift");
	await expect(page.getByText(QUICK_REPLY_DESCRIPTION)).toBeVisible();
	await expect(page.getByText(QUICK_PREVIEW_DESCRIPTION)).toBeVisible();
	await modifiedClick(page, "Alt");
	await expectCounts(page, { previews: 0, quickReplies: 1, selections: 0 });
	await row(page).click({ force: true });
	await expectCounts(page, { previews: 0, quickReplies: 1, selections: 1 });
	// The hold that opens a preview also swallows its own click.
	await modifiedHold(page, "Shift");
	await expectCounts(page, { previews: 1, quickReplies: 1, selections: 1 });

	// Quick preview → Control: Shift-hold is now an ordinary click.
	await chooseOption(page, quickPreviewTrigger(page), "Control");
	await expect(shown(quickPreviewTrigger(page))).toHaveText("Control");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:quick-preview-modifier"))
	).resolves.toBe("ctrl");
	await modifiedHold(page, "Shift");
	await expectCounts(page, { previews: 1, quickReplies: 1, selections: 2 });
	await modifiedHold(page, "Control");
	await expectCounts(page, { previews: 2, quickReplies: 1, selections: 2 });

	// Quick reply → Shift: Shift-click replies and Alt-click no longer does.
	await chooseOption(page, quickReplyTrigger(page), "Shift");
	await expect(shown(quickReplyTrigger(page))).toHaveText("Shift");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:quick-reply-modifier"))
	).resolves.toBe("shift");
	await modifiedClick(page, "Shift");
	await expectCounts(page, { previews: 2, quickReplies: 2, selections: 2 });
	await modifiedClick(page, "Alt");
	await expectCounts(page, { previews: 2, quickReplies: 2, selections: 3 });

	// Quick preview → Off: no modifier reserves the hold any more.
	await chooseOption(page, quickPreviewTrigger(page), "Off");
	await expect(shown(quickPreviewTrigger(page))).toHaveText("Off");
	await modifiedHold(page, "Control");
	await expectCounts(page, { previews: 2, quickReplies: 2, selections: 4 });

	// Both choices are read back after a reload and still drive the row.
	await page.reload();
	await expect(row(page)).toBeVisible();
	await expect(shown(quickReplyTrigger(page))).toHaveText("Shift");
	await expect(shown(quickPreviewTrigger(page))).toHaveText("Off");
	await modifiedClick(page, "Shift");
	await expectCounts(page, { previews: 0, quickReplies: 1, selections: 0 });
	// With previews off, a Shift hold is just a Shift click: a quick reply.
	await modifiedHold(page, "Shift");
	await expectCounts(page, { previews: 0, quickReplies: 2, selections: 0 });

	// Quick reply → Off: a modified click only opens the chat.
	await chooseOption(page, quickReplyTrigger(page), "Off");
	await expect(shown(quickReplyTrigger(page))).toHaveText("Off");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:quick-reply-modifier"))
	).resolves.toBe("none");
	await modifiedClick(page, "Shift");
	await modifiedClick(page, "Alt");
	await expectCounts(page, { previews: 0, quickReplies: 2, selections: 2 });

	expect(pageErrors).toEqual([]);
	const proof: ClickModifierProofState = await page.evaluate(
		() => window.__clickModifierProof
	);
	expect(proof.unexpected).toEqual([]);
});
