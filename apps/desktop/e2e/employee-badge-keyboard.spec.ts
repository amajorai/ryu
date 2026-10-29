// Real-browser keyboard proof for `EmployeeBadge` (`packages/ui`), mounted
// through `e2e/harness/employee-badge-keyboard-story.{html,tsx}`. A badge that
// opens something is the way into an agent's profile from Settings → Stats →
// "Your team", so it has to work without a pointer: reachable with Tab,
// announced as a button named for the agent, with a visible focus ring, and
// activated by Enter and Space (Space without scrolling its pane). A badge
// that opens nothing stays out of the tab order. `bun test` cannot show real
// focus order or default key actions, which is what this guards.

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/employee-badge-keyboard-story.html");
	await expect(page.getByText("Grace Hopper").first()).toBeVisible();
});

test("Tab reaches a clickable badge as a button named for its agent, Enter and Space open it once each without scrolling, and a badge that opens nothing is skipped", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const opened = page.getByTestId("opened");
	const badge = page.getByRole("button", { name: "Grace Hopper", exact: true });

	await page.getByRole("button", { name: "Before the roster" }).focus();
	await page.keyboard.press("Tab");
	await expect(badge).toBeFocused();
	await expect(badge).toContainText("Compiler engineer");
	// The focused card shows a focus ring.
	expect(
		await badge.evaluate((element) => getComputedStyle(element).boxShadow)
	).not.toBe("none");

	await page.keyboard.press("Enter");
	await expect(opened).toHaveText("1");
	await page.keyboard.press("Space");
	await expect(opened).toHaveText("2");
	// Give a (smooth) scroll from the Space press time to show in the pane.
	const pane = page.getByTestId("pane");
	await pane.evaluate(async () => {
		for (let frame = 0; frame < 30; frame += 1) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
	});
	expect(await pane.evaluate((element) => element.scrollTop)).toBe(0);
	expect(
		await pane.evaluate(
			(element) => element.scrollHeight > element.clientHeight
		)
	).toBe(true);
	await expect(badge).toBeFocused();

	// The badge that opens nothing is neither a button nor a tab stop.
	await expect(
		page.getByRole("button", { name: "Ada Lovelace", exact: true })
	).toHaveCount(0);
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("button", { name: "After the roster" })
	).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(badge).toBeFocused();

	// A pointer still opens it, once per click.
	await page.getByText("Grace Hopper", { exact: true }).click();
	await expect(opened).toHaveText("3");
	expect(errors).toEqual([]);
});
