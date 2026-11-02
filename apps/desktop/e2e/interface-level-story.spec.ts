// Real-browser spec for the interface-mode story (`e2e/harness/
// interface-level-story.{html,tsx}`), which mounts the REAL
// `InterfaceLevelMenuItem` inside a REAL account-shaped dropdown.
//
// The contract under test:
//   • one binary switch between Ryu Work and Code, with Ryu Work as the default
//     an untouched install lands on;
//   • Code is the plain checked switch: the Ryu Quiet direction keeps one accent
//     and no decorative motion, so it carries no animated gradient;
//   • clicking the switch keeps the account menu open and writes the prefs it implies
//     (hidden compact detail at Ryu Work, full detail and run stats in Code).

import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the dropdown + shared UI module graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/interface-level-story.html";
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(`console: ${message.text()}`);
		}
	});
	page.on("pageerror", (error) => {
		errors.push(`pageerror: ${error.message}`);
	});
});

test.afterEach(({ page }) => {
	expect(browserErrors.get(page)).toEqual([]);
});

async function openModePicker(page: Page) {
	await page.goto(STORY_URL);
	const trigger = page.getByRole("button", { name: "Account" });
	await expect(trigger).toBeVisible();
	await trigger.click();
	await expect(
		page.getByRole("switch", { name: "Interface mode" })
	).toBeVisible();
	await expect(page.getByRole("menu")).toHaveCount(1);
}

test("the control is a binary switch and starts in Ryu Work", async ({
	page,
}) => {
	await openModePicker(page);
	const toggle = page.getByRole("switch", { name: "Interface mode" });
	const firstMenuItem = page.getByRole("menuitem").first();
	await expect(firstMenuItem).toContainText("Ryu Work");
	await expect(firstMenuItem.locator("svg")).toHaveCount(0);
	await expect(page.getByRole("slider")).toHaveCount(0);
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("ryu:response-mode")).toHaveText("everyday");
	await expect(
		page.getByText("Ryu Work", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("Code", { exact: true }).first()).toBeVisible();
});

test("clicking the switch moves between Ryu Work and Code", async ({
	page,
}) => {
	await openModePicker(page);
	const toggle = page.getByRole("switch", { name: "Interface mode" });
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("ryu:interface-level")).toHaveText("expert");
	await expect(page.getByTestId("ryu:response-mode")).toHaveText("developer");
	await expect(toggle).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: "/tmp/ryu-response-mode-proof.png",
	});

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("ryu:interface-level")).toHaveText("simple");
	await expect(page.getByTestId("ryu:response-mode")).toHaveText("everyday");
});

test("the inline switch is keyboard-operable without closing the account menu", async ({
	page,
}) => {
	await openModePicker(page);
	const toggle = page.getByRole("switch", { name: "Interface mode" });

	await toggle.focus();
	await page.keyboard.press("Space");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(page.getByRole("menu")).toHaveCount(1);

	await page.keyboard.press("Space");
	await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("switching modes writes the prefs each mode implies", async ({ page }) => {
	await openModePicker(page);
	const toggle = page.getByRole("switch", { name: "Interface mode" });
	await page.evaluate(() =>
		localStorage.setItem("ryu:sidebar-mode", "sections")
	);

	// Code: the full transcript, commands expanded, run stats on.
	await toggle.click();
	await expect(page.getByTestId("ryu:interface-level")).toHaveText("expert");
	await expect(page.getByTestId("ryu:hide-tool-detail")).toHaveText("false");
	await expect(page.getByTestId("ryu:expand-commands")).toHaveText("true");
	await expect(page.getByTestId("ryu:inference-stats")).toHaveText("true");
	await expect(page.getByTestId("ryu:sidebar-mode")).toHaveText("sections");

	// Back to Ryu Work: nothing expanded, no tool detail at all, stats back off.
	await toggle.click();
	await expect(page.getByTestId("ryu:interface-level")).toHaveText("simple");
	await expect(page.getByTestId("ryu:hide-tool-detail")).toHaveText("true");
	await expect(page.getByTestId("ryu:expand-commands")).toHaveText("false");
	await expect(page.getByTestId("ryu:inference-stats")).toHaveText("false");
	await expect(page.getByTestId("ryu:sidebar-mode")).toHaveText("agent");
});

test("Code is the plain checked switch with no animated decoration", async ({
	page,
}) => {
	await openModePicker(page);
	const toggle = page.getByRole("switch", { name: "Interface mode" });
	const paint = () =>
		toggle.evaluate((element) => {
			const computed = getComputedStyle(element);
			return {
				animationName: computed.animationName,
				backgroundColor: computed.backgroundColor,
				backgroundImage: computed.backgroundImage,
			};
		});
	const workPaint = await paint();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(toggle).toHaveAttribute("data-checked", "");

	const codePaint = await paint();
	// The checked state still reads at a glance: its track colour changes.
	expect(codePaint.backgroundColor).not.toBe(workPaint.backgroundColor);
	expect(codePaint.backgroundImage).toBe("none");
	expect(codePaint.animationName).toBe("none");
});
