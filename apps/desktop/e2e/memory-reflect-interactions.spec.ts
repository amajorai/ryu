type ReflectFailureControls = Pick<
	FixtureSnapshot,
	"breakNudgesWriteFailuresRemaining" | "failNextDashboard"
>;

import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 60_000 });

const PAGE_URL = "/memory-reflect-interactions.html";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number;
}

interface FixtureSnapshot {
	breakNudgesWriteFailuresRemaining: number;
	failNextDashboard: number;
	failNextUsageReview: number;
	forceUnsupportedReflect: boolean;
	requests: CapturedRequest[];
	settings: {
		break_nudges: boolean;
		quiet_hours_enabled: boolean;
		quiet_hours_end: number;
		quiet_hours_start: number;
	};
}

async function openReflect(page: Page, query = "") {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${PAGE_URL}${query}`);
	await expect(
		page.getByRole("heading", { name: "Reflect", exact: true })
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await requestsFor(page, "GET", "/api/memory/reflect/settings")).length
		)
		.toBeGreaterThan(0);
}

async function captureProductScreenshot(page: Page, filename: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath(`${filename}.png`),
	});
}

async function fixtureSnapshot(page: Page): Promise<FixtureSnapshot> {
	return await page.evaluate(() => {
		const fixture =
			/* SAFETY: memory-reflect-interactions.tsx installs __memoryReflectFixture before this proof page is evaluated. */ (
				window as Window & {
					__memoryReflectFixture?: FixtureSnapshot;
				}
			).__memoryReflectFixture;
		if (!fixture) {
			throw new Error("Memory Reflect fixture was not installed.");
		}
		return {
			breakNudgesWriteFailuresRemaining:
				fixture.breakNudgesWriteFailuresRemaining,
			failNextDashboard: fixture.failNextDashboard,
			failNextUsageReview: fixture.failNextUsageReview,
			forceUnsupportedReflect: fixture.forceUnsupportedReflect,
			requests: fixture.requests,
			settings: fixture.settings,
		};
	});
}

async function requestsFor(page: Page, method: string, path: string) {
	return (await fixtureSnapshot(page)).requests.filter(
		(request) => request.method === method && request.path === path
	);
}

async function setFixtureFailure(
	page: Page,
	control: "breakNudgesWriteFailuresRemaining" | "failNextDashboard",
	value: number
) {
	await page.evaluate(
		({ control, value }) => {
			const fixture =
				/* SAFETY: memory-reflect-interactions.tsx installs __memoryReflectFixture before this proof page is evaluated. */ (
					window as Window & {
						__memoryReflectFixture?: ReflectFailureControls;
					}
				).__memoryReflectFixture;
			if (!fixture) {
				throw new Error("Memory Reflect fixture was not installed.");
			}
			fixture[control] = value;
		},
		{ control, value }
	);
}

test("Reflect period selection and refresh read back the selected dashboard and recover from Core errors", async ({
	page,
}) => {
	await openReflect(page);
	await expect(
		page.getByText("Focused regression coverage", { exact: true }).first()
	).toBeVisible();
	const period = page.getByRole("combobox", { name: "Reflect period" });
	await period.click();
	await page.getByRole("option", { name: "Last 30 days", exact: true }).click();
	await expect(
		page.getByText("Core migration planning", { exact: true }).first()
	).toBeVisible();
	let dashboardReads = await requestsFor(page, "GET", "/api/memory/reflect");
	expect(dashboardReads.map((request) => request.query.period)).toEqual([
		"7d",
		"30d",
	]);

	await setFixtureFailure(page, "failNextDashboard", 1);
	await page.getByRole("button", { name: "Refresh Reflect" }).click();
	await expect(
		page.getByText("Reflect couldn't load", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Try again", exact: true })
	).toBeVisible();
	await captureProductScreenshot(page, "memory-reflect-refresh-error-retry");

	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByText("Core migration planning", { exact: true }).first()
	).toBeVisible();
	dashboardReads = await requestsFor(page, "GET", "/api/memory/reflect");
	expect(
		dashboardReads.map((request) => [request.query.period, request.status])
	).toEqual([
		["7d", 200],
		["30d", 200],
		["30d", 503],
		["30d", 200],
	]);
	await captureProductScreenshot(page, "memory-reflect-period-readback");
});

test("Reflect reminder settings persist exact partial writes, roll back on 503, and can be reopened", async ({
	page,
}) => {
	await openReflect(page);
	const breakNudges = page.getByRole("switch", {
		name: "Break nudges",
		exact: true,
	});
	const quietHours = page.getByRole("switch", {
		name: "Quiet hours",
		exact: true,
	});
	const quietStart = page.getByRole("combobox", { name: "Quiet hours start" });
	const quietEnd = page.getByRole("combobox", { name: "Quiet hours end" });
	await expect(breakNudges).toBeChecked();
	await expect(quietHours).toBeChecked();
	await expect(quietStart).toContainText("10 PM");
	await expect(quietEnd).toContainText("8 AM");
	await captureProductScreenshot(page, "memory-reflect-settings-loaded");

	await setFixtureFailure(page, "breakNudgesWriteFailuresRemaining", 1);
	await breakNudges.click();
	await expect(
		page.getByText("Reflect settings couldn't be saved")
	).toBeVisible();
	await expect(breakNudges).toBeChecked();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).settings.break_nudges)
		.toBe(true);

	await breakNudges.click();
	await expect(breakNudges).not.toBeChecked();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).settings.break_nudges)
		.toBe(false);

	await quietHours.click();
	await expect(quietHours).not.toBeChecked();
	await expect(quietStart).toBeDisabled();
	await expect(quietEnd).toBeDisabled();
	await quietHours.click();
	await expect(quietStart).toBeEnabled();
	await expect(quietEnd).toBeEnabled();

	await quietStart.click();
	await page.getByRole("option", { name: "9 PM", exact: true }).click();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).settings.quiet_hours_start)
		.toBe(21);
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("option", { name: "9 PM", exact: true })
	).toHaveCount(0);
	await quietEnd.click();
	await page.getByRole("option", { name: "7 AM", exact: true }).click();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).settings.quiet_hours_end)
		.toBe(7);

	const writes = await requestsFor(
		page,
		"PATCH",
		"/api/memory/reflect/settings"
	);
	expect(writes.map((request) => request.body)).toEqual([
		{ break_nudges: false },
		{ break_nudges: false },
		{ quiet_hours_enabled: false },
		{ quiet_hours_enabled: true },
		{ quiet_hours_start: 21 },
		{ quiet_hours_end: 7 },
	]);
	expect(writes.map((request) => request.status)).toEqual([
		503, 200, 200, 200, 200, 200,
	]);
	await page.reload();
	await openReflect(page);
	const settingsReads = await requestsFor(
		page,
		"GET",
		"/api/memory/reflect/settings"
	);
	expect(settingsReads.map((request) => request.status)).toEqual([200]);
	expect((await fixtureSnapshot(page)).settings).toEqual({
		break_nudges: false,
		quiet_hours_enabled: true,
		quiet_hours_end: 7,
		quiet_hours_start: 21,
	});
	await expect(breakNudges).not.toBeChecked();
	await expect(quietHours).toBeChecked();
	await expect(quietStart).toContainText("9 PM");
	await expect(quietEnd).toContainText("7 AM");
	await captureProductScreenshot(page, "memory-reflect-settings-persisted");
});

test("older Core fallback shows the unsupported state and its Try again action recovers", async ({
	page,
}) => {
	await openReflect(page, "?unsupported=1");
	await expect(
		page.getByText("Reflect is not available on this node yet", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Try again", exact: true })
	).toBeVisible();
	const firstReads = await requestsFor(page, "GET", "/api/memory/reflect");
	expect(firstReads).toHaveLength(1);
	expect(firstReads[0]?.status).toBe(404);
	expect(await requestsFor(page, "GET", "/api/usage-review")).toHaveLength(1);

	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByText("Focused regression coverage", { exact: true }).first()
	).toBeVisible();
	const recoveredReads = await requestsFor(page, "GET", "/api/memory/reflect");
	expect(recoveredReads.map((request) => request.status)).toEqual([404, 200]);
	await captureProductScreenshot(page, "memory-reflect-unsupported-recovered");
});
