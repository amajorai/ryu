import path from "node:path";
import { expect, test } from "@playwright/test";

test("project files sends the exact scoped listing and persists density and search", async ({
	page,
}) => {
	await page.goto("/project-files-route-proof.html");
	await expect(
		page.getByRole("treeitem", { name: "README.md", exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
						window as Window & { __projectFiles: { calls: unknown[] } }
					).__projectFiles.calls
			)
		)
		.toContainEqual({
			command: "shell_execute",
			args: {
				command: "git ls-files --cached --others --exclude-standard",
				cwd: "/tmp/ryu-project-files-fixture",
				shell: null,
			},
		});
	await page.getByRole("button", { name: "Compact", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Compact", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "Toggle file search" }).hover();
	await expect(page.getByText("Show search", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Toggle file search" }).click();
	await expect(
		page.getByRole("button", { name: "Toggle file search" })
	).toHaveAttribute("aria-pressed", "true");
	await page.getByPlaceholder("Search…", { exact: true }).fill("untracked");
	await expect(
		page.getByRole("treeitem", { name: "untracked.ts", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Toggle file search" }).click();
	await expect(page.getByPlaceholder("Search…", { exact: true })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Toggle file search" }).click();
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Compact", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Toggle file search" })
	).toHaveAttribute("aria-pressed", "true");
});

test("failed native file opens show the host error and can be retried from the same item", async ({
	page,
}) => {
	await page.goto("/project-files-route-proof.html");
	await page.evaluate(() =>
		/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
			window as Window & {
				__projectFiles: { failNext: (command: string) => void };
			}
		).__projectFiles.failNext("open_workspace_item")
	);
	const file = page.getByRole("treeitem", { name: "README.md", exact: true });
	await file.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in VS Code", exact: true })
		.first()
		.click();
	await expect(
		page.getByText("Couldn't open that workspace item", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture workspace item unavailable", { exact: true })
	).toBeVisible();
	await file.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in VS Code", exact: true })
		.first()
		.click();
	const calls = await page.evaluate(() =>
		/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
			window as Window & {
				__projectFiles: { calls: { command: string; args: unknown }[] };
			}
		).__projectFiles.calls.filter(
			(call) => call.command === "open_workspace_item"
		)
	);
	await expect(calls).toEqual([
		{
			command: "open_workspace_item",
			args: {
				editor: "vscode",
				path: "README.md",
				root: "/tmp/ryu-project-files-fixture",
			},
		},
		{
			command: "open_workspace_item",
			args: {
				editor: "vscode",
				path: "README.md",
				root: "/tmp/ryu-project-files-fixture",
			},
		},
	]);
});

test("completed project file search is shown in the shipped route", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/project-files-route-proof.html");
	await page.getByRole("button", { name: "Relaxed", exact: true }).click();
	await page.getByRole("button", { name: "Toggle file search" }).click();
	await page.getByPlaceholder("Search…", { exact: true }).fill("untracked");
	await expect(
		page.getByRole("treeitem", { name: "untracked.ts", exact: true })
	).toBeVisible();
	await expect(page.getByRole("tree")).toHaveCSS("color-scheme", "dark");
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu:file-tree-prefs") ?? "{}")
			)
		)
		.toMatchObject({ density: "relaxed", showSearch: true });
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-project-files-search-readback.png"
		),
	});
});

test("a slow previous-folder result cannot replace the active project's files", async ({
	page,
}) => {
	await page.goto("/project-files-route-proof.html?hold=1");
	await expect(page.getByText("Loading files…", { exact: true })).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
			window as Window & {
				__projectFiles: { setFolder: (folder: string) => void };
			}
		).__projectFiles.setFolder("/tmp/ryu-new-project-fixture")
	);
	await expect(
		page.getByRole("treeitem", { name: "new-project.ts", exact: true })
	).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
			window as Window & {
				__projectFiles: { releaseHeldListing: () => void };
			}
		).__projectFiles.releaseHeldListing()
	);
	await expect(
		page.getByRole("treeitem", { name: "new-project.ts", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("treeitem", { name: "README.md", exact: true })
	).toHaveCount(0);
});

test("browser surfaces expose no native file context actions", async ({
	page,
}) => {
	await page.goto("/project-files-route-proof.html?web=1");
	await page
		.getByRole("treeitem", { name: "README.md", exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menu", { name: "Actions for README.md" })
	).toHaveCount(0);
	const mutations = await page.evaluate(() =>
		/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
			window as Window & { __projectFiles: { calls: { command: string }[] } }
		).__projectFiles.calls.filter((call) =>
			["open_workspace_item", "reveal_workspace_item"].includes(call.command)
		)
	);
	await expect(mutations).toEqual([]);
});

test("a failed file listing is visible and retries without pretending the folder is empty", async ({
	page,
}) => {
	await page.goto("/project-files-route-proof.html?failure=1");
	await expect(
		page.getByText("Fixture repository read denied", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			"No files found. This folder is empty or not a git repository."
		)
	).toHaveCount(0);
	await page.getByRole("button", { name: "Retry file listing" }).click();
	await expect(
		page.getByRole("treeitem", { name: "README.md", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture repository read denied", { exact: true })
	).toHaveCount(0);
});

test("file context actions use the exact path, configured editor and containing project", async ({
	page,
}) => {
	await page.goto("/project-files-route-proof.html");
	const file = page.getByRole("treeitem", { name: "README.md", exact: true });
	await file.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Open in VS Code", exact: true })
		.first()
		.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
						window as Window & { __projectFiles: { calls: unknown[] } }
					).__projectFiles.calls
			)
		)
		.toContainEqual({
			command: "open_workspace_item",
			args: {
				editor: "vscode",
				path: "README.md",
				root: "/tmp/ryu-project-files-fixture",
			},
		});
	await expect(
		page.getByRole("menu", { name: "Actions for README.md" })
	).toHaveCount(0);
	await file.click({ button: "right" });
	await page.getByRole("menuitem", { name: /Reveal in/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
						window as Window & { __projectFiles: { calls: unknown[] } }
					).__projectFiles.calls
			)
		)
		.toContainEqual({
			command: "reveal_workspace_item",
			args: {
				editor: null,
				path: "README.md",
				root: "/tmp/ryu-project-files-fixture",
			},
		});
	await file.click({ button: "right" });
	await expect(page.getByRole("menuitem", { name: /Cursor/ })).toHaveCount(0);
	await page
		.getByRole("menuitem", {
			name: "Open containing folder in Terminal",
			exact: true,
		})
		.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: project-files-route-proof.tsx installs __projectFiles before this proof page is evaluated. */ (
						window as Window & { __projectFiles: { calls: unknown[] } }
					).__projectFiles.calls
			)
		)
		.toContainEqual({
			command: "open_workspace_item",
			args: {
				editor: "terminal",
				path: "README.md",
				root: "/tmp/ryu-project-files-fixture",
			},
		});
});
