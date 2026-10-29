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
	await page.goto("/");
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
interface SavedState {
	schemaVersion: number;
	invoices?: Record<string, unknown>[];
	people?: Record<string, unknown>[];
}
async function stored(page: Page, app: RecordApp): Promise<SavedState> {
	const raw = await page.evaluate(
		(name) => window.__recordCompanion.stored(name),
		app
	);
	if (!raw) {
		throw new Error("The acknowledged record is missing from host storage.");
	}
	return JSON.parse(raw) as SavedState;
}
const scenarios = [
	{
		app: "invoices",
		open: "New invoice",
		submit: "Create invoice",
		title: "INV-ACTIONS",
		status: "Invoice status",
		filter: "Invoice filter",
		statuses: ["sent", "paid", "overdue", "draft"],
		fields: {
			"Invoice number": "INV-ACTIONS",
			Client: "Action isolation customer",
			Amount: "48",
			"Due date": "2026-11-03",
			Note: "Keep all unrelated invoice fields",
		},
	},
	{
		app: "people",
		open: "Add person",
		submit: "Add person",
		title: "Casey Actions",
		status: "Person status",
		filter: "People filter",
		statuses: ["active", "leave", "former", "onboarding"],
		fields: {
			Name: "Casey Actions",
			Role: "Engineer",
			Team: "Quality",
			"Start date": "2026-11-03",
			"Email (optional)": "casey@example.test",
		},
	},
] as const;
async function create(
	page: Page,
	companion: FrameLocator,
	scenario: (typeof scenarios)[number]
): Promise<SavedState> {
	await companion
		.getByRole("banner")
		.getByRole("button", { name: scenario.open, exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	const filledFields: [string, string][] = [];
	for (const [label, value] of Object.entries(scenario.fields)) {
		await dialog.getByLabel(label, { exact: true }).fill(value);
		filledFields.push([label, value]);
		for (const [filledLabel, filledValue] of filledFields) {
			await expect(
				dialog.getByLabel(filledLabel, { exact: true }),
				`${filledLabel} must retain its draft after filling ${label}`
			).toHaveValue(filledValue);
		}
	}
	for (const [label, value] of filledFields) {
		await expect(
			dialog.getByLabel(label, { exact: true }),
			`${label} must retain its complete draft before submission`
		).toHaveValue(value);
	}
	await dialog
		.getByRole("button", { name: scenario.submit, exact: true })
		.click();
	await expect(dialog).toBeHidden();
	await expect(
		companion.getByRole("heading", { name: scenario.title, exact: true })
	).toBeVisible();
	expect(await writes(page)).toHaveLength(1);
	return await stored(page, scenario.app);
}
for (const scenario of scenarios) {
	test(`${scenario.app} every status persists only its selected record field and every list filter is read-only`, async ({
		page,
	}) => {
		const companion = await mount(page, scenario.app);
		const baseline = await create(page, companion, scenario);
		const records = baseline[scenario.app];
		if (!records || records.length !== 1) {
			throw new Error("Expected one isolated acknowledged record.");
		}
		const original = records[0];
		let expected = baseline;
		for (const [index, status] of scenario.statuses.entries()) {
			await companion
				.getByLabel(scenario.status, { exact: true })
				.selectOption(status);
			expected = { ...baseline, [scenario.app]: [{ ...original, status }] };
			await expect.poll(() => stored(page, scenario.app)).toEqual(expected);
			const captured = await writes(page);
			expect(captured).toHaveLength(index + 2);
			expect(captured.at(-1)).toEqual({
				method: "storage.set",
				status: "accepted",
				input: {
					key: "state.v1",
					namespace: scenario.app,
					value: JSON.stringify(expected),
				},
			});
			for (const filter of ["all", ...scenario.statuses]) {
				await companion
					.getByLabel(scenario.filter, { exact: true })
					.selectOption(filter);
				const record = companion.getByRole("option", {
					name: new RegExp(scenario.title),
				});
				if (filter === "all" || filter === status) {
					await expect(record).toBeVisible();
				} else {
					await expect(record).toHaveCount(0);
				}
				expect(await stored(page, scenario.app)).toEqual(expected);
				expect(await writes(page)).toHaveLength(index + 2);
			}
			await companion
				.getByLabel(scenario.filter, { exact: true })
				.selectOption("all");
		}
		const reopened = await mount(page, scenario.app, false);
		await expect(
			reopened.getByLabel(scenario.status, { exact: true })
		).toHaveValue(scenario.statuses.at(-1) ?? "");
		expect(await stored(page, scenario.app)).toEqual(expected);
		expect(await writes(page)).toEqual([]);
	});

	test(`${scenario.app} Dismiss clears only a refused-save error; exact explicit retry persists the selected status and reloads it`, async ({
		page,
	}) => {
		const companion = await mount(page, scenario.app);
		const baseline = await create(page, companion, scenario);
		const status = scenario.statuses[0];
		await page.evaluate(() => window.__recordCompanion.holdNextWrite());
		await companion
			.getByLabel(scenario.status, { exact: true })
			.selectOption(status);
		await expect.poll(async () => (await writes(page)).length).toBe(2);
		await page.evaluate(() => window.__recordCompanion.releaseWrite(false));
		await expect(companion.getByRole("alert")).toContainText(
			"Changes were not saved."
		);
		expect(await stored(page, scenario.app)).toEqual(baseline);
		const beforeDismiss = await writes(page);
		expect(beforeDismiss[1]?.status).toBe("refused");
		await companion
			.getByRole("button", { name: "Dismiss", exact: true })
			.click();
		await expect(companion.getByRole("alert")).toHaveCount(0);
		expect(await stored(page, scenario.app)).toEqual(baseline);
		expect(await writes(page)).toEqual(beforeDismiss);
		await companion
			.getByLabel(scenario.status, { exact: true })
			.selectOption(status);
		await expect
			.poll(
				async () =>
					(await writes(page)).filter((call) => call.status === "accepted")
						.length
			)
			.toBe(2);
		const accepted = await writes(page);
		expect(accepted).toHaveLength(3);
		expect(accepted[2]?.input).toEqual(beforeDismiss[1]?.input);
		const persisted = await stored(page, scenario.app);
		expect(persisted).toEqual({
			...baseline,
			[scenario.app]: baseline[scenario.app]?.map((record) => ({
				...record,
				status,
			})),
		});
		const reopened = await mount(page, scenario.app, false);
		await expect(
			reopened.getByLabel(scenario.status, { exact: true })
		).toHaveValue(status);
		await expect(reopened.getByRole("alert")).toHaveCount(0);
		expect(await stored(page, scenario.app)).toEqual(persisted);
		expect(await writes(page)).toEqual([]);
	});
}
