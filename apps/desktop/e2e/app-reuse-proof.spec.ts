import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		__reuseProof?: { writes: number };
	}
}

const proof = resolve(
	import.meta.dirname,
	"../../../artifacts/app-reuse-audit"
);

for (const theme of ["light", "dark"]) {
	for (const width of [1280, 390]) {
		test(`Monitors confirmation ${theme} ${width}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await page.goto(`/monitors/?theme=${theme}&fixture=reuse-monitors`);
			await page.getByText("Audit example monitor", { exact: true }).click();
			const remove = page.getByRole("button", {
				name: "Delete monitor",
				exact: true,
			});
			await remove.click();
			const dialog = page.getByRole("alertdialog");
			await expect(dialog).toBeVisible();
			await expect(
				dialog.getByRole("button", { name: "Cancel" })
			).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(
				dialog.getByRole("button", { name: "Delete monitor" })
			).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(dialog).not.toBeVisible();
			await expect(remove).toBeFocused();
			await remove.click();
			await page.screenshot({
				path: `${proof}/monitors-confirm-${theme}-${width}.png`,
			});
			await dialog.getByRole("button", { name: "Delete monitor" }).click();
			await expect(dialog).not.toBeVisible();
			await expect(
				page.getByText("Audit example monitor", { exact: true })
			).toHaveCount(0);
			await page.screenshot({
				path: `${proof}/monitors-completed-${theme}-${width}.png`,
			});
		});
	}
}

test("host storage errors remain visible without autosaving", async ({
	page,
}) => {
	for (const app of [
		"slides",
		"drawesome",
		"people",
		"projects",
		"invoices",
		"outreach",
		"autopilot",
	]) {
		await page.goto(`/${app}/?fixture=reuse-storage-error&theme=dark`);
		await expect(page.locator("body")).toContainText(/storage|denied/i);
		await page.waitForTimeout(500);
		expect(
			await page.evaluate(() => {
				const fixture = window.__reuseProof;
				if (!fixture) {
					throw new Error("App reuse fixture was not installed");
				}
				return fixture.writes;
			})
		).toBe(0);
		await page.screenshot({ path: `${proof}/${app}-storage-error.png` });
	}
});

test("Outreach filters support arrow navigation and shared checkboxes", async ({
	page,
}) => {
	await page.goto("/outreach/?theme=light");
	const all = page.getByRole("tab", { name: "All", exact: true });
	await all.focus();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("tab", { name: "Drafts", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await all.click();
	await expect(page.locator('[data-slot="checkbox"]').first()).toBeVisible();
	await page.screenshot({ path: `${proof}/outreach-controls.png` });
});

test("Whiteboard AI dialog uses shared focus and Escape", async ({ page }) => {
	await page.goto("/whiteboard/?fixture=reuse-whiteboard&theme=dark");
	await page.getByRole("button", { name: "Generate", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Generate with AI" });
	await expect(dialog).toBeVisible();
	await page
		.getByRole("textbox", { name: "Diagram description" })
		.fill("An example review flow");
	await page.screenshot({ path: `${proof}/whiteboard-dialog.png` });
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
});

test("Rooms model selection bundles shared NativeSelect", async ({ page }) => {
	await page.goto("/rooms/?fixture=reuse-rooms&theme=light");
	const model = page.getByRole("combobox", { name: "Mesh LLM model" });
	await expect(model).toHaveValue("example-model");
	await expect(model).toHaveAttribute("data-slot", "native-select");
	await expect(page.getByRole("button", { name: "Start room" })).toBeEnabled();
	await page.screenshot({ path: `${proof}/rooms-model.png` });
});

test("a host without Token Table capabilities never becomes a demo game", async ({
	page,
}) => {
	await page.goto("/token-table/?fixture=reuse-unavailable&theme=dark");
	await expect(
		page.getByText("Token Table unavailable", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Leave table" })).toHaveCount(
		0
	);
	await page.screenshot({ path: `${proof}/token-table-unavailable.png` });
});

test("Token Table inherits the host dark theme", async ({ page }) => {
	await page.goto("/token-table/?theme=dark");
	await expect(page.locator(".token-table-app")).toBeVisible();
	const colors = await page.evaluate(() => ({
		root: getComputedStyle(document.documentElement)
			.getPropertyValue("--background")
			.trim(),
		app: getComputedStyle(document.querySelector(".token-table-app")!)
			.getPropertyValue("--background")
			.trim(),
	}));
	expect(colors.app).toBe(colors.root);
	const button = page.getByRole("button", { name: "Leave table", exact: true });
	const geometry = await button.evaluate((element) => ({
		display: getComputedStyle(element).display,
		radius: Number.parseFloat(getComputedStyle(element).borderRadius),
		padding: Number.parseFloat(getComputedStyle(element).paddingLeft),
	}));
	expect(["flex", "inline-flex"]).toContain(geometry.display);
	expect(geometry.radius).toBeGreaterThan(0);
	expect(geometry.padding).toBeGreaterThan(0);
	const track = page.locator('[data-slot="slider-track"]');
	const trackBounds = await track.boundingBox();
	expect(trackBounds?.width).toBeGreaterThan(30);
	expect(trackBounds?.height).toBeGreaterThan(0);
	const seat = await page.locator(".poker-seat--south").boundingBox();
	const dock = await page.locator(".poker-action-dock").boundingBox();
	expect(seat && dock && seat.y + seat.height <= dock.y).toBe(true);
	await page.screenshot({ path: `${proof}/token-table-dark.png` });
	const history = page.getByRole("button", { name: "Open hand history" });
	await history.click();
	await expect(
		page.getByRole("dialog", { name: "Hand history" })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("dialog", { name: "Hand history" })
	).not.toBeVisible();
	await expect(history).toBeFocused();
});

test("Clips opens manifest view context with shared upload and no private sidebar", async ({
	page,
}) => {
	await page.addInitScript(() => {
		/* SAFETY: This addInitScript writes the authored Clips view context on its own browser window before navigation. The property remains unknown in this write-only view; no broad app bridge or external JSON contract is claimed. */ (
			window as Window & { ryu: unknown }
		).ryu = {
			context: { view: "create" },
		};
	});
	await page.goto("/clips/?theme=light");
	await expect(
		page.getByText("Start with a video", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Drop files here", { exact: true })
	).toBeVisible();
	await expect(page.locator(".clips-sidebar")).toHaveCount(0);
	await page.screenshot({ path: `${proof}/clips-create.png` });
});
