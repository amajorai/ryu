import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const fixtureDir = path.resolve(
	import.meta.dirname,
	"../../../target/mcp-settings-proof"
);

test.beforeEach(async () => {
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(
		path.join(fixtureDir, "settings.json"),
		JSON.stringify({ units: "mm", showGrid: false, lineWidth: 2 })
	);
});

test("production settings renderer saves changed fields to the fixture filesystem", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});
	await page.goto("/mcp-settings-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("heading", { name: "Plugin settings", exact: true })
	).toBeVisible();
	await page
		.getByRole("combobox", { name: "Agent for plugin access" })
		.selectOption("proof-agent");
	await expect(
		page.getByRole("button", { name: "mm", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "in", exact: true }).click();
	await page.getByRole("checkbox", { name: "Show grid", exact: true }).check();
	await page
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
	expect(
		JSON.parse(await readFile(path.join(fixtureDir, "settings.json"), "utf8"))
	).toEqual({ units: "in", showGrid: true, lineWidth: 2 });
	expect(
		JSON.parse(await readFile(path.join(fixtureDir, "events.json"), "utf8"))
	).toEqual({
		tool: "parts.settings.update",
		agent_id: "proof-agent",
		arguments: { set: { units: "in", showGrid: true } },
	});
	await page
		.getByRole("button", { name: "Verify settings", exact: true })
		.click();
	await expect(
		page.getByText("Settings verified against the local fixture.", {
			exact: true,
		})
	).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath("settings-completed-light.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page.getByRole("button", { name: "Dark mode", exact: true }).click();
	await page.screenshot({
		path: test.info().outputPath("settings-completed-dark.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: test.info().outputPath("settings-completed-narrow.png"),
		animations: "disabled",
		fullPage: true,
	});
	await page.reload();
	await page
		.getByRole("combobox", { name: "Agent for plugin access" })
		.selectOption("proof-agent");
	await expect(
		page.getByRole("button", { name: "in", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("checkbox", { name: "Show grid", exact: true })
	).toBeChecked();
	expect(errors).toEqual([]);
	await writeFile(
		test.info().outputPath("settings-persisted.json"),
		await readFile(path.join(fixtureDir, "settings.json"))
	);
	await writeFile(
		test.info().outputPath("settings-update-event.json"),
		await readFile(path.join(fixtureDir, "events.json"))
	);
	await writeFile(
		test.info().outputPath("settings-browser-errors.json"),
		JSON.stringify(errors)
	);
});

test("loading and no-agent states explain the unavailable settings access", async ({
	page,
}) => {
	let release: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/agents", async (route) => {
		await pending;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ agents: [] }),
		});
	});
	await page.goto("/mcp-settings-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByText("Loading agents…", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Agent for plugin access" })
	).toBeDisabled();
	release?.();
	await expect(
		page.getByText(
			"Add an agent with access to this plugin to configure its settings.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Agent for plugin access" })
	).toBeDisabled();
	await page.screenshot({
		path: test.info().outputPath("settings-no-agent.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("a denied update remains visible and leaves persisted values unchanged", async ({
	page,
}) => {
	await page.route("**/api/mcp/tools/call", async (route) => {
		if (route.request().postDataJSON().tool === "parts.settings.update") {
			await route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({
					ok: false,
					error: "Fixture denied this update",
				}),
			});
		} else {
			await route.continue();
		}
	});
	await page.goto("/mcp-settings-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByRole("combobox", { name: "Agent for plugin access" })
		.selectOption("proof-agent");
	await page.getByRole("button", { name: "in", exact: true }).click();
	await page
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Fixture denied this update"
	);
	await expect(page.getByText("Settings saved", { exact: true })).toHaveCount(
		0
	);
	expect(
		JSON.parse(await readFile(path.join(fixtureDir, "settings.json"), "utf8"))
	).toEqual({ units: "mm", showGrid: false, lineWidth: 2 });
});

for (const scenario of [
	{
		name: "pending authorization",
		output: { __ryu_elicitation__: { id: "approval" } },
		error:
			"Additional approval or authentication is required before this action can complete.",
	},
	{
		name: "provider failure",
		output: {
			isError: true,
			content: [{ type: "text", text: "Fixture provider failed" }],
		},
		error: "Fixture provider failed",
	},
	{
		name: "unapplied update",
		output: { content: [] },
		error: "The plugin has not applied the requested changes. Try again.",
	},
]) {
	test(`${scenario.name} cannot claim a successful settings save`, async ({
		page,
	}) => {
		await page.route("**/api/mcp/tools/call", async (route) => {
			if (route.request().postDataJSON().tool === "parts.settings.update") {
				await route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ ok: true, output: scenario.output }),
				});
			} else {
				await route.continue();
			}
		});
		await page.goto("/mcp-settings-proof.html", {
			waitUntil: "domcontentloaded",
		});
		await page
			.getByRole("combobox", { name: "Agent for plugin access" })
			.selectOption("proof-agent");
		await page.getByRole("button", { name: "in", exact: true }).click();
		await page
			.getByRole("button", { name: "Save settings", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveText(scenario.error);
		await expect(
			page.getByRole("button", { name: "Save settings", exact: true })
		).toBeEnabled();
		await expect(page.getByText("Settings saved", { exact: true })).toHaveCount(
			0
		);
		expect(
			JSON.parse(await readFile(path.join(fixtureDir, "settings.json"), "utf8"))
		).toEqual({ units: "mm", showGrid: false, lineWidth: 2 });
		await page.screenshot({
			animations: "disabled",
			path: test
				.info()
				.outputPath(`settings-${scenario.name.replaceAll(" ", "-")}.png`),
			fullPage: true,
		});
	});
}
