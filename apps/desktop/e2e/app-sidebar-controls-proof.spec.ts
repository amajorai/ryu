import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const sectionOrderSchema = z.array(z.string());

const STORY_URL = "/app-sidebar-controls-proof.html";

async function openFreshProof(page: Page) {
	await page.goto(STORY_URL);
	await page.evaluate(() => localStorage.clear());
	await page.reload();
}

test.describe("AppSidebar section and navigation controls", () => {
	test("scope picker writes and restores the selected project scope", async ({
		page,
	}) => {
		await openFreshProof(page);

		const picker = page.getByRole("combobox");
		await expect(picker).toContainText("All projects");
		await picker.click();
		await page.getByRole("option", { name: "Project Beta" }).click();

		await expect(page.getByTestId("scope-value")).toHaveText("/workspace/beta");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:sidebar-project-selection")
			)
		).toBe("/workspace/beta");
		await page.reload();
		await expect(page.getByRole("combobox")).toContainText("Project Beta");
		await expect(page.getByTestId("scope-value")).toHaveText("/workspace/beta");
	});

	test("paging reveals and hides the exact next page, then searchable overflow finds an unpaged row", async ({
		page,
	}) => {
		await openFreshProof(page);
		await expect(page.getByTestId("visible-items")).toHaveText("AlphaBravo");
		await page
			.getByRole("button", { name: "Show 4 more", exact: true })
			.click();
		await expect(page.getByTestId("visible-items")).toHaveText(
			"AlphaBravoCharlieDelta"
		);
		await page
			.getByRole("button", { name: "Show 2 less", exact: true })
			.click();
		await expect(page.getByTestId("visible-items")).toHaveText("AlphaBravo");

		await page.evaluate(() => {
			localStorage.setItem("ryu:sidebar-overflow-popover", "true");
		});
		await page.reload();
		await page
			.getByRole("button", { name: "Show 4 more", exact: true })
			.click();
		const search = page.getByPlaceholder("Search projects");
		await expect(search).toBeVisible();
		await search.fill("echo");
		await expect(page.getByRole("button", { name: "Echo" })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Alpha", exact: true })
		).toHaveCount(0);
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-overflow-search.png"
			),
			fullPage: true,
			animations: "disabled",
		});
		await page.getByRole("button", { name: "Echo" }).click();
		await expect(page.getByTestId("selected-item")).toHaveText("echo");
		await search.fill("no matching project");
		await expect(page.getByText("No matches")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(search).toBeHidden();
		await page
			.getByRole("button", { name: "Show 4 more", exact: true })
			.click();
		await expect(search).toHaveValue("");
		await expect(page.getByRole("button", { name: "Echo" })).toBeVisible();
	});

	test("section overflow actions move, hide, sort, page, and open customize with saved state", async ({
		page,
	}) => {
		await openFreshProof(page);
		const menuButton = page.getByRole("button", { name: "Projects options" });
		const readOrder = async () =>
			sectionOrderSchema.parse(
				JSON.parse(
					(await page.getByTestId("section-order").textContent()) ?? "[]"
				)
			);

		const before = await readOrder();
		await menuButton.click();
		await page.getByRole("menuitem", { name: "Move up" }).click();
		const after = await readOrder();
		expect(after.indexOf("projects")).toBe(before.indexOf("projects") - 1);
		expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("ryu:sidebar-section-order")
				)) ?? "[]"
			)
		).toEqual(after);
		await page.reload();
		expect(await readOrder()).toEqual(after);

		// Moving the section to the first slot disables the unavailable direction.
		for (let index = 0; index < 2; index += 1) {
			await page.getByRole("button", { name: "Projects options" }).click();
			await page.getByRole("menuitem", { name: "Move up" }).click();
		}
		await page.getByRole("button", { name: "Projects options" }).click();
		await expect(
			page.getByRole("menuitem", { name: "Move up" })
		).toBeDisabled();
		await expect(
			page.getByRole("menuitem", { name: "Move down" })
		).toBeEnabled();
		await page.getByRole("menuitem", { name: "Move down" }).click();
		const afterMoveDown = await readOrder();
		expect(afterMoveDown.indexOf("projects")).toBe(1);
		expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("ryu:sidebar-section-order")
				)) ?? "[]"
			)
		).toEqual(afterMoveDown);

		await page.getByRole("button", { name: "Projects options" }).click();
		const sortBy = page.getByRole("menuitem", { name: "Sort by" });
		await expect(sortBy).toBeVisible();
		await sortBy.focus();
		await page.keyboard.press("ArrowRight");
		const nameAscending = page.getByRole("menuitemradio", {
			name: "Name (A-Z)",
		});
		await expect(nameAscending).toBeVisible();
		await nameAscending.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("sort-value")).toHaveText("name-asc");
		await expect(page.getByTestId("visible-items")).toHaveText("AlphaBravo");
		await expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("ryu:sidebar-section-sorts")
				)) ?? "{}"
			).projects
		).toBe("name-asc");

		await page.getByRole("button", { name: "Projects options" }).click();
		const showItems = page.getByRole("menuitem", { name: "Show items" });
		await expect(showItems).toBeVisible();
		await showItems.focus();
		await page.keyboard.press("ArrowRight");
		const fiveItems = page.getByRole("menuitemradio", {
			name: "5",
			exact: true,
		});
		await expect(fiveItems).toBeVisible();
		await fiveItems.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("page-size")).toHaveText("5");
		await expect(page.getByTestId("visible-items")).toHaveText(
			"AlphaBravoCharlieDeltaEcho"
		);
		await expect(
			JSON.parse(
				(await page.evaluate(() =>
					localStorage.getItem("ryu:sidebar-section-page-sizes")
				)) ?? "{}"
			).projects
		).toBe(5);

		await page.getByRole("button", { name: "Projects options" }).click();
		await page.getByRole("menuitem", { name: "Customize sidebar" }).click();
		await expect(page.getByTestId("customize-open")).toHaveText("true");
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-section-menu.png"
			),
			fullPage: true,
			animations: "disabled",
		});
		await page.getByRole("button", { name: "Projects options" }).click();
		await page.getByRole("menuitem", { name: "Hide section" }).click();
		await expect(page.getByTestId("section-hidden")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Projects options" })
		).toHaveCount(0);
		await expect(page.getByTestId("hidden-sections")).toContainText("projects");

		await page.reload();
		await expect(page.getByTestId("hidden-sections")).toContainText("projects");
		await expect(page.getByTestId("section-hidden")).toBeVisible();
		await expect(page.getByTestId("section-order")).toHaveText(
			JSON.stringify(afterMoveDown)
		);
		await expect(page.getByTestId("page-size")).toHaveText("5");
		await expect(page.getByTestId("sort-value")).toHaveText("name-asc");
	});

	test("section and subsection add actions open their exact flows without collapsing the section", async ({
		page,
	}) => {
		await openFreshProof(page);
		const section = page.getByTestId("projects-section");
		await section.hover();
		await page.getByRole("button", { name: "Create project" }).click();
		await expect(page.getByTestId("last-action")).toHaveText("Create project");
		await expect(page.getByTestId("projects-content")).toBeVisible();

		await page.getByTestId("subsection-header").hover();
		await page.getByRole("button", { name: "Add folder" }).click();
		await expect(page.getByTestId("last-action")).toHaveText("Add folder");
		await expect(page.getByTestId("projects-content")).toBeVisible();
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-sidebar-add-actions.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	});
});
