import { expect, type Page, test } from "@playwright/test";
import {
	type AddWidgetProofState,
	addWidgetProofStateSchema,
} from "./add-widget-proof.contracts.ts";

const STORY_URL = "/add-widget-dialog-proof.html";
const SCREENSHOT_PATH = "/tmp/ryu-add-widget-dialog-proof.png";
const DEFAULT_SCREENSHOT_PATH = "/tmp/ryu-add-widget-dialog-default.png";

const KINDS = [
	{
		id: "stat",
		label: "Stat / KPI number",
		layout: { x: 0, y: 0, w: 3, h: 3 },
	},
	{ id: "line_chart", label: "Line chart", layout: { x: 0, y: 0, w: 6, h: 4 } },
	{ id: "bar_chart", label: "Bar chart", layout: { x: 0, y: 0, w: 6, h: 4 } },
	{ id: "area_chart", label: "Area chart", layout: { x: 0, y: 0, w: 6, h: 4 } },
	{ id: "pie_chart", label: "Pie chart", layout: { x: 0, y: 0, w: 4, h: 4 } },
	{ id: "table", label: "Table", layout: { x: 0, y: 0, w: 6, h: 4 } },
	{ id: "list", label: "List", layout: { x: 0, y: 0, w: 4, h: 4 } },
	{ id: "text", label: "Text / Markdown", layout: { x: 0, y: 0, w: 4, h: 3 } },
	{ id: "map", label: "Map", layout: { x: 0, y: 0, w: 6, h: 5 } },
	{ id: "agent_feed", label: "Agent feed", layout: { x: 0, y: 0, w: 4, h: 4 } },
] as const;

async function readState(page: Page): Promise<AddWidgetProofState> {
	return addWidgetProofStateSchema.parse(
		JSON.parse(
			(await page.getByTestId("widget-proof-state").textContent()) ?? "{}"
		)
	);
}

async function selectOption(
	page: Page,
	comboboxIndex: number,
	optionLabel: string
) {
	await page.getByRole("combobox").nth(comboboxIndex).click();
	await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function selectSource(page: Page, sourceLabel: string) {
	await selectOption(page, 1, sourceLabel);
}

async function submit(page: Page) {
	const previousCount = (await readState(page)).createCount;
	const submitButton = page
		.getByRole("dialog")
		.getByRole("button", { name: "Add widget", exact: true });
	await expect(submitButton).toBeEnabled();
	await submitButton.click();
	await expect
		.poll(async () => (await readState(page)).createCount)
		.toBe(previousCount + 1);
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
}

test("all catalog widget kinds produce their exact callback kind and default layout", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("combobox").nth(0).click();
	for (const kind of KINDS) {
		await expect(
			page.getByRole("option", { name: kind.label, exact: true })
		).toBeVisible();
	}
	await page.keyboard.press("Escape");
	await page.getByLabel("Title").click();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: DEFAULT_SCREENSHOT_PATH,
	});

	for (const [index, kind] of KINDS.entries()) {
		if (index > 0) {
			await page.getByRole("button", { name: "Open widget dialog" }).click();
		}
		await selectOption(page, 0, kind.label);
		const title = `Verified ${kind.id}`;
		await page.getByLabel("Title").fill(title);
		await submit(page);
		await expect(page.getByTestId("widget-proof-status")).toHaveText(
			`Created ${title}`
		);
		await expect
			.poll(async () => readState(page))
			.toMatchObject({
				createCount: index + 1,
				created: {
					kind: kind.id,
					title,
					source: {
						endpoint: "agents.list",
						selector: null,
						type: "core_endpoint",
					},
					refresh_interval: "30s",
					config: {},
					layout: kind.layout,
				},
				open: false,
			});
	}
});

test("core endpoint options and trimmed selector reach the create callback exactly", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectOption(page, 2, "gateway.health");
	await page.getByLabel("Selector (optional)").fill("  status  ");
	await page.getByLabel("Title").fill("  Gateway status  ");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: {
				title: "Gateway status",
				source: {
					endpoint: "gateway.health",
					selector: "status",
					type: "core_endpoint",
				},
			},
		});
});

test("monitor and workflow sources submit their own trimmed identifiers", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectSource(page, "Website monitor");
	await page.getByLabel("Monitor id").fill("  monitor-42  ");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: {
				source: { monitor_id: "monitor-42", type: "monitor" },
			},
		});

	await page.getByRole("button", { name: "Open widget dialog" }).click();
	await selectSource(page, "Workflow output");
	await page.getByLabel("Workflow id").fill("  workflow-7  ");
	await page.getByLabel("Output key (optional)").fill("  summary  ");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 2,
			created: {
				source: {
					output_key: "summary",
					type: "workflow",
					workflow_id: "workflow-7",
				},
			},
		});
});

test("Composio source parses valid arguments and falls back to an empty object for invalid JSON", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectSource(page, "Composio action");
	await page.getByLabel("Composio action").fill("  GMAIL_FETCH_EMAILS  ");
	await page
		.getByLabel("Arguments (JSON, optional)")
		.fill('{ "max_results": 5 }');
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: {
				source: {
					action: "GMAIL_FETCH_EMAILS",
					args: { max_results: 5 },
					type: "composio",
				},
			},
		});

	await page.getByRole("button", { name: "Open widget dialog" }).click();
	await page.getByLabel("Arguments (JSON, optional)").fill("{ invalid");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 2,
			created: { source: { args: {}, type: "composio" } },
		});
});

test("HTTP source preserves its URL and normalizes an empty selector", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectSource(page, "External HTTP (https)");
	await page.getByLabel("URL (https)").fill("  https://example.test/metrics  ");
	await page.getByLabel("Selector (optional)").fill("    ");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: {
				source: {
					selector: null,
					type: "http",
					url: "https://example.test/metrics",
				},
			},
		});
});

test("agent source submits the prompt and optional agent id after trimming", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectSource(page, "Agent (re-runs on interval)");
	await page.getByLabel("Agent id").fill("  agent-9  ");
	await page
		.getByLabel("Prompt", { exact: true })
		.fill("  Summarize the latest run as JSON  ");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: {
				source: {
					agent_id: "agent-9",
					prompt: "Summarize the latest run as JSON",
					type: "agent",
				},
			},
		});
});

test("static data disables refresh and submits valid JSON or null on invalid JSON", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectSource(page, "Static / inline data");
	await expect(page.getByLabel("Refresh every")).toBeDisabled();
	await page.getByLabel("Inline data (JSON)").fill('{ "value": 42 }');
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: { source: { data: { value: 42 }, type: "static" } },
		});

	await page.getByRole("button", { name: "Open widget dialog" }).click();
	await page.getByLabel("Inline data (JSON)").fill("{ invalid");
	await expect(page.getByLabel("Refresh every")).toBeDisabled();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: SCREENSHOT_PATH,
	});
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 2,
			created: { source: { data: null, type: "static" } },
		});
});

test("custom config JSON, invalid-JSON fallback, default title, and blank refresh are explicit", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByRole("combobox").nth(0).click();
	await page.getByRole("option", { name: "Line chart", exact: true }).click();
	await page.getByLabel("Title").fill("   ");
	await page.getByLabel("Refresh every").fill("   ");
	await page.getByText("Advanced: display config (JSON)").click();
	const config = page.getByPlaceholder(/charts:.*x_key/, { exact: false });
	await expect(config).toBeVisible();
	await config.fill('{ "x_key": "day", "series": ["signups"] }');
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			created: {
				kind: "line_chart",
				title: "Line chart",
				refresh_interval: null,
				config: { series: ["signups"], x_key: "day" },
			},
		});

	await page.getByRole("button", { name: "Open widget dialog" }).click();
	await page.getByText("Advanced: display config (JSON)").click();
	await page
		.getByPlaceholder(/charts:.*x_key/, { exact: false })
		.fill("{ nope");
	await submit(page);
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 2,
			created: { config: {}, refresh_interval: null },
		});
});

test("Cancel and Escape close the dialog without invoking the create callback", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 0,
			created: null,
			open: false,
		});

	await page.getByRole("button", { name: "Open widget dialog" }).click();
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 0,
			open: false,
		});

	await page.getByRole("button", { name: "Open widget dialog" }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect
		.poll(async () => readState(page))
		.toMatchObject({
			createCount: 0,
			open: false,
		});
});
