// Real-browser spec for the agent approval story (`e2e/harness/
// agent-approval-story.html`) — the beui surfaces wired into chat.
//
// Every assertion here is one that tsc and the bundler cannot make: shiki
// tokenisation is async, button count comes from runtime data, and the row
// geometry is layout.

import { expect, test } from "@playwright/test";

// Cold Vite compiles the tool-registry + shiki + motion module graph on first
// navigation, and the grammar itself is a further async chunk. Serialised
// because four workers racing a cold dev server starve each other past any
// timeout worth setting.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const STORY_URL = "/agent-approval-story.html";

test("the permission card offers every option the agent sent", async ({
	page,
}) => {
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	const card = page.getByTestId("permission-prompt");
	await expect(card).toBeVisible();

	// The old bug rendered a FIXED Approve/Skip pair. Four ACP options must
	// produce four buttons — a regression to a hardcoded pair fails here. The
	// details toggle is a button too, so exclude it rather than counting it.
	const decisions = card
		.getByRole("button")
		.filter({ hasNotText: "View details" });
	await expect(decisions).toHaveCount(4);
	await expect(card.getByText("Allow once")).toBeVisible();
	await expect(card.getByText("Never allow")).toBeVisible();
	await expect(card.getByText("Approval required")).toBeVisible();
});

test("the permission card highlights the command it is asking about", async ({
	page,
}) => {
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	const card = page.getByTestId("permission-prompt");

	// A highlighted line is split into per-token spans carrying the theme
	// variables. Plain text renders as ONE bare string, so the presence of a
	// coloured token span is what proves the grammar actually loaded.
	const token = card.locator("pre code span[style*='--agent-code-light']");
	await expect(token.first()).toBeVisible({ timeout: 30_000 });
});

test("Simple keeps approval language human-readable", async ({ page }) => {
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	const card = page.getByTestId("simple-permission-prompt");

	await expect(card).toBeVisible();
	await expect(card.getByText("Ryu wants to take an action")).toBeVisible();
	await expect(
		card.getByText("run a shell command", { exact: true })
	).toBeVisible();
	await expect(card.locator("pre")).toHaveCount(0);
});

test("the bash row's approval strip renders one button per option", async ({
	page,
}) => {
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	const card = page.getByTestId("bash-card");
	await expect(card).toBeVisible();
	// The row is a beUI ToolResult disclosure whose header is itself a button,
	// so the count is 1 (disclosure) + 4 (approval options) — the old fixed
	// Approve/Skip pair would produce 3, so the option count still gates it.
	await expect(card.getByRole("button")).toHaveCount(5);

	// The command is highlighted in the row itself, not just in the card above.
	const token = card.locator("pre code span[style*='--agent-code-light']");
	await expect(token.first()).toBeVisible({ timeout: 30_000 });
});

test("a long MCP payload scrolls inside its row instead of stretching it", async ({
	page,
}) => {
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	const row = page.getByTestId("mcp-row");
	await expect(row).toBeVisible();

	// `ToolResultOutput` has no height cap of its own. Under the default
	// (non-expanded) display pref the row must supply one — the markdown path it
	// replaced capped at 240px, and dropping that without a replacement let the
	// payload stretch the row to ~2850px.
	const height = await row.evaluate((el) => el.getBoundingClientRect().height);
	expect(height).toBeLessThan(400);
});
