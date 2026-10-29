import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type {
	RecordApp,
	RecordCall,
	RecordCompanionApi,
} from "./harness/record-companion-regression.types.ts";

declare global {
	interface Window {
		__recordCompanion: RecordCompanionApi;
	}
}
async function mount(
	page: Page,
	app: RecordApp,
	reset = true
): Promise<FrameLocator> {
	if (!page.url().startsWith("http")) {
		await page.goto("/");
	}
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(
		path.join(tmpdir(), `ryu-record-companion-${app}-build/index.html`),
		"utf8"
	);
	await page.evaluate((input) => window.__recordCompanion.mount(input), {
		app,
		appHtml,
		reset,
	});
	await expect
		.poll(() => page.evaluate(() => window.__recordCompanion.connected()))
		.toBe(true);
	return page.frameLocator('iframe[title="Record Companion regression"]');
}
async function writes(page: Page): Promise<RecordCall[]> {
	return await page.evaluate(() =>
		window.__recordCompanion
			.calls()
			.filter((call) => call.method === "storage.set")
	);
}
async function stored(page: Page, app: RecordApp): Promise<unknown> {
	const value = await page.evaluate(
		(name) => window.__recordCompanion.stored(name),
		app
	);
	return value === null ? null : JSON.parse(value);
}
const recordCases = [
	{
		app: "invoices",
		open: "New invoice",
		submit: "Create invoice",
		title: "INV-20261008",
		fields: {
			"Invoice number": "INV-20261008",
			Client: "Regression customer",
			Amount: "1200.50",
			"Due date": "2026-11-02",
			Note: "Retain this invoice draft",
		},
		expected: {
			number: "INV-20261008",
			client: "Regression customer",
			amountMinor: 120_050,
			dueDate: "2026-11-02",
			note: "Retain this invoice draft",
			status: "draft",
		},
	},
	{
		app: "people",
		open: "Add person",
		submit: "Add person",
		title: "Alex Regression",
		fields: {
			Name: "Alex Regression",
			Role: "Quality engineer",
			Team: "Product",
			"Start date": "2026-11-02",
			"Email (optional)": "ALEX@EXAMPLE.TEST",
		},
		expected: {
			name: "Alex Regression",
			role: "Quality engineer",
			team: "Product",
			startDate: "2026-11-02",
			email: "alex@example.test",
			status: "onboarding",
		},
	},
] as const;
for (const config of recordCases) {
	test(`${config.app} invalid and cancelled creation never writes host storage`, async ({
		page,
	}) => {
		const companion = await mount(page, config.app);
		await companion
			.getByRole("button", { name: config.open, exact: true })
			.click();
		const dialog = companion.getByRole("dialog");
		if (config.app === "invoices") {
			await dialog
				.getByLabel("Invoice number", { exact: true })
				.fill(config.title);
			await dialog
				.getByLabel("Client", { exact: true })
				.fill("Invalid amount customer");
			await dialog.getByLabel("Amount", { exact: true }).fill("0");
		}
		await dialog
			.getByRole("button", { name: config.submit, exact: true })
			.click();
		await expect(dialog).toBeVisible();
		expect(await writes(page)).toEqual([]);
		expect(await stored(page, config.app)).toBeNull();
		for (const [label, value] of Object.entries(config.fields)) {
			await dialog.getByLabel(label, { exact: true }).fill(value);
		}
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		expect(await writes(page)).toEqual([]);
		expect(await stored(page, config.app)).toBeNull();
		await page.reload();
		const reopened = await mount(page, config.app, false);
		await expect(
			reopened.getByRole("heading", { name: config.title, exact: true })
		).toHaveCount(0);
		expect(await writes(page)).toEqual([]);
	});

	test(`${config.app} held creation prevents duplicate writes, refusal preserves draft, and explicit retry creates one durable record`, async ({
		page,
	}) => {
		const companion = await mount(page, config.app);
		await companion
			.getByRole("button", { name: config.open, exact: true })
			.click();
		const dialog = companion.getByRole("dialog");
		for (const [label, value] of Object.entries(config.fields)) {
			await dialog.getByLabel(label, { exact: true }).fill(value);
		}
		await page.evaluate(() => window.__recordCompanion.holdNextWrite());
		await dialog
			.getByRole("button", { name: config.submit, exact: true })
			.click();
		await expect.poll(async () => (await writes(page)).length).toBe(1);
		try {
			const pending = dialog.getByRole("button", {
				name: "Saving…",
				exact: true,
			});
			await expect(pending).toBeDisabled();
			await pending.click({ force: true });
			expect(await writes(page)).toHaveLength(1);
			expect(await stored(page, config.app)).toBeNull();
		} finally {
			await page.evaluate(() => window.__recordCompanion.releaseWrite(false));
		}
		await expect(dialog.getByRole("alert")).toContainText("was not saved");
		for (const [label, value] of Object.entries(config.fields)) {
			await expect(dialog.getByLabel(label, { exact: true })).toHaveValue(
				value
			);
		}
		expect(await stored(page, config.app)).toBeNull();
		const refused = (await writes(page))[0];
		expect(refused).toMatchObject({
			method: "storage.set",
			status: "refused",
			input: { namespace: config.app, key: "state.v1" },
		});
		expect(Object.keys(refused?.input ?? {}).sort()).toEqual([
			"key",
			"namespace",
			"value",
		]);
		const rejectedState = JSON.parse(refused?.input.value ?? "null");
		expect(rejectedState[config.app]).toHaveLength(1);
		expect(rejectedState[config.app][0]).toMatchObject(config.expected);
		await dialog
			.getByRole("button", { name: config.submit, exact: true })
			.click();
		await expect(dialog).toBeHidden();
		await expect(
			companion.getByRole("heading", { name: config.title, exact: true })
		).toBeVisible();
		const accepted = await writes(page);
		expect(accepted).toHaveLength(2);
		expect(accepted[1]).toMatchObject({
			status: "accepted",
			input: { namespace: config.app, key: "state.v1" },
		});
		const persisted = (await stored(page, config.app)) as Record<
			string,
			unknown[]
		>;
		expect(persisted[config.app]).toHaveLength(1);
		expect(persisted[config.app]?.[0]).toMatchObject(config.expected);
		await page.reload();
		const reopened = await mount(page, config.app, false);
		await expect(
			reopened.getByRole("heading", { name: config.title, exact: true })
		).toBeVisible();
		expect(await stored(page, config.app)).toEqual(persisted);
		expect(await writes(page)).toEqual([]);
	});
}

async function stroke(
	page: Page,
	companion: FrameLocator,
	offset: number
): Promise<void> {
	const bounds = await companion
		.locator("svg.drawesome-drawing-surface")
		.boundingBox();
	if (!bounds) {
		throw new Error("The actual drawing surface is unavailable.");
	}
	await page.mouse.move(bounds.x + 60 + offset, bounds.y + 80);
	await page.mouse.down();
	await page.mouse.move(bounds.x + 120 + offset, bounds.y + 130, { steps: 4 });
	await page.mouse.move(bounds.x + 170 + offset, bounds.y + 180, { steps: 4 });
	await page.mouse.up();
}

test("Drawesome custom ink and brush size affect real strokes; undo/redo restore exact durable drawing history across reload", async ({
	page,
}) => {
	const companion = await mount(page, "drawesome");
	await expect(companion.getByTestId("drawesome-save-state")).toHaveAttribute(
		"aria-label",
		"Sketch ready"
	);
	await companion
		.getByLabel("Sketch title", { exact: true })
		.fill("History regression");
	await companion
		.getByLabel("Choose a custom ink color", { exact: true })
		.fill("#123456");
	const brush = companion.getByLabel("Brush size", { exact: true });
	await brush.focus();
	await brush.press("Home");
	for (let i = 0; i < 11; i += 1) {
		await brush.press("ArrowRight");
	}
	await expect(brush).toHaveValue("12");
	await stroke(page, companion, 0);
	await expect
		.poll(() => stored(page, "drawesome"))
		.toMatchObject({
			title: "History regression",
			strokes: [
				expect.objectContaining({
					color: "#123456",
					size: 12,
					pen: "pen",
					opacity: 1,
				}),
			],
		});
	const original = await stored(page, "drawesome");
	await companion.getByRole("button", { name: "Undo", exact: true }).click();
	await expect
		.poll(() => stored(page, "drawesome"))
		.toMatchObject({ strokes: [] });
	await expect(
		companion.getByRole("button", { name: "Undo", exact: true })
	).toBeDisabled();
	await companion.getByRole("button", { name: "Redo", exact: true }).click();
	await expect.poll(() => stored(page, "drawesome")).toEqual(original);
	await expect(
		companion.getByRole("button", { name: "Redo", exact: true })
	).toBeDisabled();
	await page.reload();
	const reopened = await mount(page, "drawesome", false);
	await expect(
		reopened.getByLabel("Sketch title", { exact: true })
	).toHaveValue("History regression");
	await expect(
		reopened.locator("svg.drawesome-drawing-surface path")
	).not.toHaveCount(0);
	expect(await stored(page, "drawesome")).toEqual(original);
});

test("Drawesome highlighter creates translucent marker strokes and selected eraser changes the persisted drawing rather than a toolbar label", async ({
	page,
}) => {
	const companion = await mount(page, "drawesome");
	await expect(companion.getByTestId("drawesome-save-state")).toHaveAttribute(
		"aria-label",
		"Sketch ready"
	);
	await companion
		.getByRole("button", { name: "Ink #496cdd", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Highlighter", exact: true })
		.click();
	await stroke(page, companion, 0);
	await expect
		.poll(() => stored(page, "drawesome"))
		.toMatchObject({
			strokes: [
				expect.objectContaining({
					pen: "marker",
					color: "#496cdd",
					opacity: 0.42,
				}),
			],
		});
	const original = (await stored(page, "drawesome")) as { strokes: unknown[] };
	await companion.getByRole("button", { name: "Eraser", exact: true }).click();
	await stroke(page, companion, 0);
	await expect
		.poll(() => stored(page, "drawesome"))
		.toMatchObject({
			strokes: [
				original.strokes[0],
				expect.objectContaining({ erase: true, size: 6, pen: "pen" }),
			],
		});
	await companion.getByRole("button", { name: "Undo", exact: true }).click();
	await expect.poll(() => stored(page, "drawesome")).toEqual(original);
	await companion.getByRole("button", { name: "Pen", exact: true }).click();
	await stroke(page, companion, 180);
	await expect
		.poll(() => stored(page, "drawesome"))
		.toMatchObject({
			strokes: [
				original.strokes[0],
				expect.objectContaining({
					pen: "pen",
					color: "#496cdd",
					opacity: 1,
					size: 6,
				}),
			],
		});
});
