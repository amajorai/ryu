// Real-browser spec for the file-tree theme story (`e2e/harness/
// file-tree-theme-story.{html,tsx}`), which mounts the REAL
// `useFileTreeThemeStyles` hook + a REAL `@pierre/trees` `<FileTree>`.
//
// What's actually at risk (and therefore what's asserted):
//   • `@pierre/trees` has no light/dark modes — the hook resolves the chosen
//     theme through `@pierre/diffs`' Shiki cache (an async `import()` that only
//     runs in a browser) and turns it into `--trees-theme-*` custom properties
//     on the host element;
//   • the `TREE_THEME_INHERIT` default must push NOTHING, so the tree keeps the
//     app's own surface colors — that's what makes the new pref backwards
//     compatible with how the Files tab renders today.

import { expect, test } from "@playwright/test";

// The story pulls the Pierre + Shiki module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/file-tree-theme-story.html";

test.describe("file tree theming — real hook in isolation", () => {
	test("inherit keeps the selected app light mode when the OS is dark", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(STORY_URL);
		await expect(page.getByTestId("tree")).toHaveCSS("color-scheme", "light");
	});

	test("the inherit default pushes no theme variables", async ({ page }) => {
		await page.goto(STORY_URL);
		const tree = page.getByTestId("tree");
		await expect(tree).toBeVisible();
		await expect(page.getByTestId("pref")).toHaveText("__inherit__");
		expect(await tree.getAttribute("style")).not.toContain("--trees-theme");
	});

	test("picking a theme resolves it and writes the tree variables", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("tree")).toBeVisible();
		await page.getByTestId("set-github-light").click();
		// Resolution is async on first use (Shiki lazily imports the theme JSON).
		await expect
			.poll(async () => await page.getByTestId("tree").getAttribute("style"), {
				timeout: 20_000,
			})
			.toContain("--trees-theme");
	});

	// Guards the OTHER surface too: the same catalog feeds the diff viewer, where
	// an unknown id throws inside the renderer instead of failing a type-check.
	test("every catalog theme id resolves against Shiki's bundle", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await page.goto(STORY_URL);
		await expect(page.getByTestId("tree")).toBeVisible();
		const failed = await page.evaluate(() =>
			/* SAFETY: file-tree-theme-story.tsx installs __resolveEveryCatalogTheme before this proof page is evaluated. */ (
				window as Window & {
					__resolveEveryCatalogTheme: () => Promise<string[]>;
				}
			).__resolveEveryCatalogTheme()
		);
		expect(failed).toEqual([]);
	});

	test("switching back to inherit drops the variables again", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByTestId("set-github-light").click();
		await expect
			.poll(async () => await page.getByTestId("tree").getAttribute("style"), {
				timeout: 20_000,
			})
			.toContain("--trees-theme");
		await page.getByTestId("set-inherit").click();
		await expect
			.poll(async () => await page.getByTestId("tree").getAttribute("style"))
			.not.toContain("--trees-theme");
	});
});
