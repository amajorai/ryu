import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 60_000 });

const PAGE_URL = "/import-setup-dialog-interactions.html";

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
}

interface ImportFixtureSnapshot {
	failedImportsRemaining: number;
	failedScansRemaining: number;
	importedCallbackCount: number;
	projectFolders: string[];
	projectIds: string[];
	requests: RecordedRequest[];
}

async function openPage(page: Page) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(PAGE_URL);
	await expect(
		page.getByRole("dialog", { name: "Import agent setup" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Claude Code", exact: true })
	).toBeVisible();
}

async function captureProductScreenshot(page: Page, filename: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath(`${filename}.png`),
	});
}

async function setFixtureFailure(
	page: Page,
	control: "failedImportsRemaining" | "failedScansRemaining"
) {
	await page.evaluate((control) => {
		const fixture =
			/* SAFETY: import-setup-dialog-interactions.tsx installs __importSetupFixture before this proof page is evaluated. */ (
				window as Window & {
					__importSetupFixture?: Pick<
						ImportFixtureSnapshot,
						"failedImportsRemaining" | "failedScansRemaining"
					>;
				}
			).__importSetupFixture;
		if (!fixture) {
			throw new Error("Import setup fixture was not installed.");
		}
		fixture[control] = 1;
	}, control);
}

async function fixtureSnapshot(page: Page): Promise<ImportFixtureSnapshot> {
	return await page.evaluate(() => {
		const fixture =
			/* SAFETY: import-setup-dialog-interactions.tsx installs __importSetupFixture before this proof page is evaluated. */ (
				window as Window & {
					__importSetupFixture?: ImportFixtureSnapshot;
				}
			).__importSetupFixture;
		if (!fixture) {
			throw new Error("Import setup fixture was not installed.");
		}
		return {
			failedImportsRemaining: fixture.failedImportsRemaining,
			failedScansRemaining: fixture.failedScansRemaining,
			importedCallbackCount: fixture.importedCallbackCount,
			projectFolders: fixture.projectFolders,
			projectIds: fixture.projectIds,
			requests: fixture.requests,
		};
	});
}

async function requestsFor(page: Page, method: string, path: string) {
	return (await fixtureSnapshot(page)).requests.filter(
		(request) => request.method === method && request.path === path
	);
}

function row(dialog: ReturnType<Page["getByRole"]>, name: RegExp) {
	return dialog.getByRole("button", { name });
}

test("scans, selects, retries, imports partial outcomes, and registers an instruction project", async ({
	page,
}) => {
	await openPage(page);
	const dialog = page.getByRole("dialog", { name: "Import agent setup" });
	await dialog
		.getByRole("button", { name: "Claude Code", exact: true })
		.click();
	await expect(dialog.getByText(".claude", { exact: true })).toBeVisible();
	await expect(dialog.getByText("One ignored file was skipped.")).toBeVisible();
	await expect(dialog.getByText("0 of 8 selected")).toBeVisible();
	for (const group of [
		"Instructions",
		"Skills",
		"MCP servers",
		"Plugins",
		"Memories",
		"Agents",
		"Slash commands",
	]) {
		await expect(
			dialog.getByRole("heading", { name: group, exact: true })
		).toBeVisible();
	}

	const scanRequests = await requestsFor(page, "POST", "/api/import/scan");
	expect(scanRequests).toHaveLength(1);
	expect(scanRequests[0]?.body).toEqual({ path: "/home/fixture/.claude" });

	await dialog.getByRole("button", { name: "Select all", exact: true }).click();
	await expect(dialog.getByText("8 of 8 selected")).toBeVisible();
	await dialog
		.getByRole("button", { name: "Deselect all", exact: true })
		.click();
	await expect(dialog.getByText("0 of 8 selected")).toBeVisible();
	const skillsGroupHeader = dialog
		.getByRole("heading", { name: "Skills", exact: true })
		.locator("xpath=..");
	await skillsGroupHeader
		.getByRole("button", { name: "Select", exact: true })
		.click();
	await expect(dialog.getByText("2 of 8 selected")).toBeVisible();
	await skillsGroupHeader
		.getByRole("button", { name: "Deselect", exact: true })
		.click();
	await expect(dialog.getByText("0 of 8 selected")).toBeVisible();

	const instructions = row(dialog, /Claude instructions/);
	const plugin = row(dialog, /Formatter plugin/);
	const memory = row(dialog, /Project preferences/);
	await instructions.click();
	await plugin.click();
	await memory.click();
	await expect(instructions).toHaveAttribute("aria-pressed", "true");
	await expect(plugin).toHaveAttribute("aria-pressed", "true");
	await expect(memory).toHaveAttribute("aria-pressed", "true");
	await expect(dialog.getByText("3 of 8 selected")).toBeVisible();

	await setFixtureFailure(page, "failedImportsRemaining");
	await dialog.getByRole("button", { name: "Import 3", exact: true }).click();
	await expect(dialog.getByText("Failed to import: 503")).toBeVisible();
	await expect(instructions).toHaveAttribute("aria-pressed", "true");
	await expect(
		dialog.getByRole("button", { name: "Import 3", exact: true })
	).toBeEnabled();
	await captureProductScreenshot(
		page,
		"import-setup-dialog-import-error-retry"
	);

	await dialog.getByRole("button", { name: "Import 3", exact: true }).click();
	await expect(
		dialog.getByText("Imported 1, skipped 1, failed 1")
	).toBeVisible();
	await expect(
		dialog.getByText("Memory import is disabled for this project.")
	).toBeVisible();
	const runRequests = await requestsFor(page, "POST", "/api/import/run");
	expect(runRequests).toHaveLength(2);
	const expectedRunBody = {
		items: [
			{ id: "instructions/CLAUDE.md", kind: "instructions" },
			{ id: "plugins/formatter.json", kind: "plugin" },
			{ id: "memory/preferences.md", kind: "memory" },
		],
		path: "/home/fixture/.claude",
	};
	expect(runRequests[0]?.body).toEqual(expectedRunBody);
	expect(runRequests[1]?.body).toEqual(expectedRunBody);

	await expect
		.poll(async () => (await fixtureSnapshot(page)).projectFolders)
		.toContain("/workspace/claude-project");
	const readback = await fixtureSnapshot(page);
	expect(readback.importedCallbackCount).toBe(1);
	expect(readback.projectIds).toHaveLength(1);
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu_workspace_recents") ?? "[]")
			)
		)
		.toContain("/workspace/claude-project");
	await captureProductScreenshot(
		page,
		"import-setup-dialog-partial-results-project-added"
	);

	await dialog
		.getByRole("button", { name: "Close", exact: true })
		.first()
		.click();
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "Open Import Agent Setup" }).click();
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Claude Code", exact: true })
	).toBeVisible();
	await expect(dialog.getByText("Claude instructions")).toHaveCount(0);
	await expect(dialog.getByText("Imported 1, skipped 1, failed 1")).toHaveCount(
		0
	);

	await page.reload();
	await openPage(page);
	await expect
		.poll(async () => (await fixtureSnapshot(page)).projectFolders)
		.toContain("/workspace/claude-project");
});

test("browses a node folder, retries a failed scan, and Change clears the previous selection", async ({
	page,
}) => {
	await openPage(page);
	const dialog = page.getByRole("dialog", { name: "Import agent setup" });
	await setFixtureFailure(page, "failedScansRemaining");

	async function chooseNodeFolder(name: "AgentWorkspace" | "Docs") {
		await dialog.getByRole("button", { name: "Choose a folder…" }).click();
		const browser = page.getByRole("dialog", {
			name: "Add a project folder to Ryu",
		});
		await expect(browser).toBeVisible();
		const projects = browser.getByRole("option", { name: /Projects/ });
		await expect(projects).toBeVisible();
		await projects.click();
		const destination = browser.getByRole("option", { name: new RegExp(name) });
		await expect(destination).toBeVisible();
		await destination.click();
		await browser.getByRole("button", { name: "Add folder to Ryu" }).click();
	}

	await chooseNodeFolder("AgentWorkspace");
	await expect(dialog.getByText("Failed to scan folder: 503")).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Choose a folder…" })
	).toBeVisible();
	await captureProductScreenshot(
		page,
		"import-setup-dialog-folder-scan-error-retry"
	);
	let scanRequests = await requestsFor(page, "POST", "/api/import/scan");
	expect(scanRequests).toHaveLength(1);
	expect(scanRequests[0]?.body).toEqual({
		path: "/home/fixture/Projects/AgentWorkspace",
	});

	await chooseNodeFolder("AgentWorkspace");
	await expect(
		dialog.getByText("AgentWorkspace", { exact: true })
	).toBeVisible();
	await expect(dialog.getByText("0 of 8 selected")).toBeVisible();
	await row(dialog, /Claude instructions/).click();
	await expect(dialog.getByText("1 of 8 selected")).toBeVisible();
	await dialog.getByRole("button", { name: "Change", exact: true }).click();
	const browser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(browser).toBeVisible();
	await browser.getByRole("option", { name: /Projects/ }).click();
	const docs = browser.getByRole("option", { name: /Docs/ });
	await expect(docs).toBeVisible();
	await docs.click();
	await browser.getByRole("button", { name: "Add folder to Ryu" }).click();
	await expect(dialog.getByText("Docs", { exact: true })).toBeVisible();
	await expect(dialog.getByText("0 of 8 selected")).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Import", exact: true })
	).toBeDisabled();
	scanRequests = await requestsFor(page, "POST", "/api/import/scan");
	expect(scanRequests.map((request) => request.body)).toEqual([
		{ path: "/home/fixture/Projects/AgentWorkspace" },
		{ path: "/home/fixture/Projects/AgentWorkspace" },
		{ path: "/home/fixture/Projects/Docs" },
	]);
	const directoryRequests = await requestsFor(
		page,
		"GET",
		"/api/workspace/list"
	);
	expect(
		directoryRequests.some((request) => request.query.path === "::this-pc")
	).toBe(true);
	await captureProductScreenshot(
		page,
		"import-setup-dialog-folder-change-readback"
	);
});
