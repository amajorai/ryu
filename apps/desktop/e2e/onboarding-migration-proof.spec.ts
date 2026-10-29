import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 60_000 });

const PAGE_URL = "/onboarding-migration-proof.html";

interface MigrationFixtureSnapshot {
	continued: number;
	requests: { body: unknown; method: string; path: string }[];
	skipped: number;
}

async function snapshot(page: Page): Promise<MigrationFixtureSnapshot> {
	return page.evaluate(() => {
		const fixture =
			/* SAFETY: onboarding-migration-proof.tsx installs __migrationFixture before this proof page is evaluated. */ (
				window as Window & { __migrationFixture?: MigrationFixtureSnapshot }
			).__migrationFixture;
		if (!fixture) {
			throw new Error("Migration fixture was not installed.");
		}
		return JSON.parse(JSON.stringify(fixture));
	});
}

async function screenshot(page: Page, name: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath(`${name}.png`),
	});
}

test("detects OpenClaw, imports only new items, then continues", async ({
	page,
}) => {
	await page.goto(PAGE_URL);
	await expect(
		page.getByRole("heading", { name: "Coming from another agent?" })
	).toBeVisible();
	await expect(page.getByText("OpenClaw", { exact: true })).toBeVisible();
	await expect(
		page.getByText("1 agent · 2 memory files · 1 skill · 1 MCP server")
	).toBeVisible();
	await expect(page.getByText("1 already in Ryu")).toBeVisible();
	await page.getByText("2 things to set up again").click();
	await expect(
		page.getByText(/Channels configured in OpenClaw \(telegram, discord\)/)
	).toBeVisible();
	await screenshot(page, "onboarding-migration-detected");

	const scans = (await snapshot(page)).requests.filter((r) =>
		r.path.endsWith("/api/import/scan")
	);
	expect(scans.map((r) => r.body)).toEqual([
		{ path: "/home/fixture/.claude" },
		{ path: "/home/fixture/.codex" },
		{ path: "/home/fixture/.cursor" },
		{ path: "/home/fixture/.openclaw" },
		{ path: "/home/fixture/.hermes" },
	]);

	await page.getByRole("button", { name: "Import 5 items" }).click();
	await expect.poll(async () => (await snapshot(page)).continued).toBe(1);
	const run = (await snapshot(page)).requests.find((r) =>
		r.path.endsWith("/api/import/run")
	);
	expect(run?.body).toEqual({
		path: "/home/fixture/.openclaw",
		items: [
			{ kind: "agent", id: "agent/workspace/SOUL.md" },
			{ kind: "memory", id: "memory/workspace/MEMORY.md" },
			{ kind: "memory", id: "memory/workspace/USER.md" },
			{ kind: "skill", id: "skill/workspace/skills/deploy" },
			{ kind: "mcp_server", id: "mcp_server/mcp/openclaw/docs" },
		],
	});
	await expect(
		page.getByText("5 imported, 0 skipped, 0 failed.")
	).toBeVisible();
});

test("adds a picked Mastra project and lets the user deselect a source", async ({
	page,
}) => {
	await page.goto(PAGE_URL);
	await expect(page.getByText("OpenClaw", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Choose a folder…" }).click();
	const browser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await expect(browser).toBeVisible();
	await browser.getByRole("option", { name: /Projects/ }).click();
	await browser.getByRole("option", { name: /mastra-app/ }).click();
	await browser.getByRole("button", { name: "Add folder to Ryu" }).click();

	await expect(page.getByText("Mastra", { exact: true })).toBeVisible();
	await expect(page.getByText("2 agents", { exact: true })).toBeVisible();
	await page.getByRole("checkbox", { name: /^OpenClaw/ }).click();
	await screenshot(page, "onboarding-migration-mastra");

	await page.getByRole("button", { name: "Import 2 items" }).click();
	await expect.poll(async () => (await snapshot(page)).continued).toBe(1);
	const runs = (await snapshot(page)).requests.filter((r) =>
		r.path.endsWith("/api/import/run")
	);
	expect(runs.map((r) => (r.body as { path: string }).path)).toEqual([
		"/home/fixture/Projects/mastra-app",
	]);
});

test("imports a picked ChatGPT export's chats, projects, and custom instructions", async ({
	page,
}) => {
	await page.goto(PAGE_URL);
	await expect(page.getByText("OpenClaw", { exact: true })).toBeVisible();
	await page.getByRole("checkbox", { name: /^OpenClaw/ }).click();
	await page.getByRole("button", { name: "Choose a folder…" }).click();
	const browser = page.getByRole("dialog", {
		name: "Add a project folder to Ryu",
	});
	await browser.getByRole("option", { name: /Projects/ }).click();
	await browser.getByRole("option", { name: /chatgpt-export/ }).click();
	await browser.getByRole("button", { name: "Add folder to Ryu" }).click();

	await expect(page.getByText("ChatGPT", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Chats · 1 project · saved context", { exact: true })
	).toBeVisible();
	await screenshot(page, "onboarding-migration-chatgpt");

	await page.getByRole("button", { name: "Import 3 items" }).click();
	await expect.poll(async () => (await snapshot(page)).continued).toBe(1);
	const runs = (await snapshot(page)).requests.filter((r) =>
		r.path.endsWith("/api/import/run")
	);
	expect(runs.map((r) => r.body)).toEqual([
		{
			path: "/home/fixture/Downloads/chatgpt-export",
			items: [
				{ kind: "conversations", id: "conversations/conversations.json#chats" },
				{
					kind: "conversations",
					id: "conversations/conversations.json#g-p-685bb57d",
				},
				{ kind: "memory", id: "memory/conversations.json#saved-context" },
			],
		},
	]);
});

test("skip leaves everything untouched", async ({ page }) => {
	await page.goto(PAGE_URL);
	await expect(page.getByText("OpenClaw", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Skip for now" }).click();
	const state = await snapshot(page);
	expect(state.skipped).toBe(1);
	expect(state.requests.some((r) => r.path.endsWith("/api/import/run"))).toBe(
		false
	);
});
