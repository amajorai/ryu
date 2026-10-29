import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const NOW = "2026-10-02T08:00:00Z";
const evidence = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence"
);
function job(id: string, name: string, target: Record<string, string>) {
	return {
		id,
		name,
		target,
		schedule: { kind: "cron", expr: "0 9 * * *" },
		enabled: true,
		created_at: NOW,
		updated_at: NOW,
		history: [],
		last_run_at: null,
		last_outcome: null,
		owner_app: null,
		require_approval: false,
	};
}
async function open(
	page: Page,
	agent = "agent-calendar",
	extraJobs: ReturnType<typeof job>[] = []
) {
	const reads: { path: string; authorization: string | undefined }[] = [];
	const unexpected: string[] = [];
	await page.clock.install({ time: new Date(NOW) });
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/heartbeat/jobs") {
			reads.push({
				path: url.pathname,
				authorization: request.headers().authorization,
			});
			await route.fulfill({
				json: {
					jobs: [
						job("mine", "Morning review", {
							type: "agent",
							agent_id: "agent-calendar",
							prompt: "Review",
						}),
						job("other", "Other agent secret", {
							type: "agent",
							agent_id: "agent-other",
							prompt: "Other",
						}),
						job("workflow", "Workflow secret", {
							type: "workflow",
							workflow_id: "workflow-other",
						}),
						job("system", "Identity maintenance", { type: "identity_health" }),
						...extraJobs,
					],
				},
			});
			return;
		}
		if (url.pathname === "/workflows") {
			await route.fulfill({ json: { workflows: [] } });
			return;
		}
		if (url.pathname === "/api/conversations") {
			await route.fulfill({ json: { conversations: [] } });
			return;
		}
		if (url.pathname === "/agents") {
			await route.fulfill({ json: { agents: [] } });
			return;
		}
		if (
			url.pathname.startsWith("/engines") ||
			url.pathname.startsWith("/api/")
		) {
			await route.fulfill({ json: {} });
			return;
		}
		if (url.origin !== "http://127.0.0.1:5391") {
			unexpected.push(request.url());
			await route.abort();
			return;
		}
		await route.continue();
	});
	await page.goto(`/calendar-navigation-proof.html?agent=${agent}`);
	await expect(
		page.getByRole("button", { name: "Month", exact: true })
	).toBeVisible();
	await expect.poll(() => reads.length).toBeGreaterThan(0);
	expect(
		reads.every(
			(read) => read.authorization === "Bearer calendar-navigation-token"
		)
	).toBe(true);
	expect(unexpected).toEqual([]);
	return reads;
}
async function shot(page: Page, name: string) {
	await mkdir(evidence, { recursive: true });
	await page.screenshot({
		path: path.join(evidence, name),
		animations: "disabled",
	});
}

test("saved agent calendar filters actual wire jobs and navigates exact Month/Week/Day/Agenda periods", async ({
	page,
}) => {
	const reads = await open(page);
	await expect(
		page.getByRole("button", { name: /Morning review/ }).first()
	).toBeVisible();
	await expect(
		page.getByText("Other agent secret", { exact: true })
	).toHaveCount(0);
	await expect(page.getByText("Workflow secret", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByText("Identity maintenance", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Show system jobs" })
	).toHaveCount(0);
	const periods = [
		{
			view: "Month",
			current: "October 2026",
			next: "November 2026",
			previous: "September 2026",
		},
		{
			view: "Week",
			current: "Sep 27 – Oct 3, 2026",
			next: "Oct 4 – 10, 2026",
			previous: "Sep 20 – 26, 2026",
		},
		{
			view: "Day",
			current: "Friday, October 2, 2026",
			next: "Saturday, October 3, 2026",
			previous: "Thursday, October 1, 2026",
		},
		{
			view: "Agenda",
			current: "Oct 2 – Oct 31, 2026",
			next: "Nov 1 – Nov 30, 2026",
			previous: "Sep 2 – Oct 1, 2026",
		},
	];
	for (const period of periods) {
		await page.getByRole("button", { name: period.view, exact: true }).click();
		await expect(page.getByText(period.current, { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Next", exact: true }).click();
		await expect(page.getByText(period.next, { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Previous", exact: true }).click();
		await page.getByRole("button", { name: "Previous", exact: true }).click();
		await expect(
			page.getByText(period.previous, { exact: true })
		).toBeVisible();
		await page.getByRole("button", { name: "Today", exact: true }).click();
		await expect(page.getByText(period.current, { exact: true })).toBeVisible();
		await shot(
			page,
			`calendar-navigation-${period.view.toLowerCase()}-completed.png`
		);
	}
	expect(reads).toEqual([
		{
			path: "/heartbeat/jobs",
			authorization: "Bearer calendar-navigation-token",
		},
	]);
});

test("month cell and event pill select the real day panel; close, day and week event selection work", async ({
	page,
}) => {
	await open(page);
	// A month cell holds its day button and its run pills side by side: no
	// button inside another, and each pill sits above the day button it shares
	// the cell with, so hovering and clicking it reach the pill itself.
	await expect(page.locator("button button")).toHaveCount(0);
	const october2 = page.getByRole("button", {
		name: "Friday, October 2, 2026",
		exact: true,
	});
	await october2.click();
	await expect(page.locator("aside")).toContainText("October 2, 2026");
	await expect(page.locator("aside")).toContainText("Morning review");
	await page.locator("aside button").click();
	await expect(page.locator("aside")).toHaveCount(0);
	const octoberEvent = page
		.locator("div.min-h-\\[104px\\]")
		.filter({ has: october2 })
		.getByRole("button", { name: /09:00 Morning review/ });
	await octoberEvent.hover();
	await page.clock.runFor(1000);
	await expect(
		page.getByText("Morning review — Daily at 9 AM", { exact: true })
	).toBeVisible();
	await octoberEvent.click();
	await expect(page.locator("aside")).toContainText("October 2, 2026");
	await page.locator("aside button").click();
	await page.getByRole("button", { name: "Today", exact: true }).click();
	await page.locator("aside button").click();
	await page.getByRole("button", { name: "Day", exact: true }).click();
	await page.getByRole("button", { name: /09:00 Morning review/ }).click();
	await expect(page.locator("aside")).toContainText("October 2, 2026");
	await shot(page, "calendar-navigation-day-panel.png");
	await page.locator("aside button").click();
	await page.getByRole("button", { name: "Week", exact: true }).click();
	await page
		.getByRole("button", { name: /09:00 Morning review/ })
		.last()
		.click();
	await expect(page.locator("aside")).toContainText("October 3, 2026");
});

test("a crowded month cell opens its day from the +N more line, which sits over the day button", async ({
	page,
}) => {
	const crowd = ["Standup notes", "Inbox sweep", "Metrics digest"];
	await open(
		page,
		"agent-calendar",
		crowd.map((name, index) =>
			job(`crowd-${index}`, name, {
				type: "agent",
				agent_id: "agent-calendar",
				prompt: name,
			})
		)
	);
	const october2 = page.locator("div.min-h-\\[104px\\]").filter({
		has: page.getByRole("button", {
			name: "Friday, October 2, 2026",
			exact: true,
		}),
	});
	const more = october2.getByText("+1 more", { exact: true });
	await expect(more).toBeVisible();
	// A real pointer press where the line is drawn: it must reach the day.
	const box = await more.boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	}
	const panel = page.locator("aside");
	await expect(panel).toContainText("October 2, 2026");
	for (const name of ["Morning review", ...crowd]) {
		await expect(panel).toContainText(name);
	}
});

test("narrow saved-agent calendar toolbar remains reachable after navigation and selected-agent switch", async ({
	page,
}) => {
	await page.setViewportSize({ width: 430, height: 900 });
	await open(page, "agent-other");
	await expect(
		page.getByRole("button", { name: /Other agent secret/ }).first()
	).toBeVisible();
	await expect(page.getByText("Morning review", { exact: true })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.getByRole("button", { name: "Today", exact: true }).click();
	await page.locator("aside button").click();
	await page.getByRole("button", { name: "Agenda", exact: true }).click();
	for (const name of [
		"Previous",
		"Next",
		"Today",
		"Month",
		"Week",
		"Day",
		"Agenda",
		"Refresh",
		"New automation",
	]) {
		const button = page.getByRole("button", { name, exact: true });
		await expect(button).toBeVisible();
		const box = await button.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(430);
	}
	await shot(page, "calendar-navigation-narrow-toolbar.png");
});
