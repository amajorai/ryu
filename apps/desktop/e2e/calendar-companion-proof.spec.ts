import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import {
	bundle,
	coreRequest,
	evidenceDir,
	expectButtonWithinCell,
	fixtureState,
	job,
	mountCalendar,
	type ScheduleCase,
	workflow,
} from "./calendar-companion-proof.helpers.ts";

test.beforeAll(async () => {
	await mkdir(evidenceDir, { recursive: true });
});

test("shared Button keeps vertical event content inside its allocated cell", async ({
	page,
}) => {
	await page.goto("/button-layout-proof.html");
	await page.waitForSelector('body[data-button-layout-proof-ready="1"]');
	const cell = page.getByRole("button", { name: "Calendar day cell" });
	const event = page.getByRole("button", {
		name: /08:00 PM Quarterly compliance report with an exceptionally long title/,
	});
	const [cellBox, eventBox] = await Promise.all([
		cell.boundingBox(),
		event.boundingBox(),
	]);
	expect(cellBox).not.toBeNull();
	expect(eventBox).not.toBeNull();
	if (cellBox && eventBox) {
		expect(eventBox.x).toBeGreaterThanOrEqual(cellBox.x);
		expect(eventBox.x + eventBox.width).toBeLessThanOrEqual(
			cellBox.x + cellBox.width + 1
		);
	}
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-shared-button-cell-bounds.png"),
	});
});

test("calendar navigation, event details, workflow names, and system-job visibility work", async ({
	page,
}) => {
	const calendar = await mountCalendar(page, {
		jobs: [
			job(
				"job-deploy",
				"Deployment schedule",
				{ type: "workflow", workflow_id: "workflow-deploy" },
				{ kind: "every", interval: "7d" }
			),
			job(
				"job-long-title",
				"Quarterly compliance report with an exceptionally long title",
				{ type: "agent", agent_id: "agent-analyst", prompt: "Run" },
				{ kind: "every", interval: "7d" }
			),
			job(
				"job-maintenance",
				"Core maintenance",
				{ type: "identity_health" },
				{ kind: "every", interval: "1d" }
			),
			job(
				"job-agent",
				"Nightly QA",
				{ type: "agent", agent_id: "agent-analyst", prompt: "Run" },
				{ kind: "cron", expr: "0 9 * * 2" },
				{
					history: [
						{
							started_at: "2026-09-22T09:00:00.000Z",
							finished_at: "2026-09-22T09:01:00.000Z",
							outcome: "failure",
							error: "The QA environment is unavailable.",
							run_id: "run-failed-qa",
						},
					],
					last_run_at: "2026-09-22T09:01:00.000Z",
					last_outcome: "failure",
				}
			),
		],
		workflows: [workflow("workflow-deploy", "Deployment workflow")],
	});
	// One recorded run and one future Tuesday in the visible grid; earlier
	// Tuesdays must not reappear as upcoming events without run records.
	await expect(calendar.getByText("Nightly QA", { exact: true })).toHaveCount(
		2
	);

	await expect(
		calendar.getByText("September 2026", { exact: true })
	).toBeVisible();
	await expect(
		calendar.getByRole("button", { name: "Show system jobs" })
	).toHaveAttribute("aria-pressed", "false");
	await expect(
		calendar.getByText("Core maintenance", { exact: true })
	).toHaveCount(0);

	const deployment = calendar
		.getByText("Deployment schedule", { exact: true })
		.first()
		.locator("xpath=ancestor::button[1]");
	await deployment.hover();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-month-event-tooltip.png"),
	});
	await expect(
		calendar.getByText("Deployment schedule — Every 7d", { exact: true })
	).toBeVisible();
	await expectButtonWithinCell(
		deployment,
		deployment.locator("xpath=ancestor::button[1]")
	);
	const longEvent = calendar
		.getByText("Quarterly compliance report with an exceptionally long title", {
			exact: true,
		})
		.first()
		.locator("xpath=ancestor::button[1]");
	await expectButtonWithinCell(
		longEvent,
		longEvent.locator("xpath=ancestor::button[1]")
	);
	await deployment.click();
	const dayPanel = calendar.locator("aside");
	await expect(dayPanel).toBeVisible();
	await expect(dayPanel).toContainText("Deployment workflow");
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-month-event-detail.png"),
	});
	await dayPanel.getByRole("button").click();
	await expect(dayPanel).not.toBeVisible();

	await calendar
		.getByRole("button")
		.filter({ has: calendar.getByText("22", { exact: true }) })
		.first()
		.click();
	await expect(dayPanel).toContainText("September 22, 2026");
	await expect(dayPanel).toContainText("The QA environment is unavailable.");
	await dayPanel.getByRole("button").click();

	await calendar
		.getByRole("button")
		.filter({ has: calendar.getByText("15", { exact: true }) })
		.first()
		.click();
	await expect(dayPanel).toContainText("September 15, 2026");
	await expect(dayPanel).toContainText("No runs scheduled");
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"calendar-past-cron-occurrences-not-upcoming.png"
		),
	});
	await dayPanel.getByRole("button").click();

	await calendar
		.getByRole("button")
		.filter({ has: calendar.getByText("24", { exact: true }) })
		.first()
		.click();
	await expect(dayPanel).toContainText("September 24, 2026");
	await expect(dayPanel).toContainText("No runs scheduled");
	await dayPanel.getByRole("button").click();

	await calendar.getByRole("button", { name: "Next" }).click();
	await expect(
		calendar.getByText("October 2026", { exact: true })
	).toBeVisible();
	await calendar.getByRole("button", { name: "Previous" }).click();
	await expect(
		calendar.getByText("September 2026", { exact: true })
	).toBeVisible();
	await calendar.getByRole("button", { name: "Today" }).click();
	await expect(dayPanel).toBeVisible();

	await calendar.getByRole("button", { name: "Week", exact: true }).click();
	await expect(calendar.getByText(/Sep 20.+Sep 26, 2026/)).toBeVisible();
	const weekEvent = calendar.getByRole("button", {
		name: /Deployment schedule/,
	});
	await weekEvent.first().hover();
	await expect(
		calendar.getByText("Deployment schedule — Every 7d", { exact: true })
	).toBeVisible();
	await weekEvent.first().click();
	await expect(dayPanel).toBeVisible();
	await calendar.getByRole("button", { name: "Day", exact: true }).click();
	await expect(
		calendar.getByText(/Wednesday, September 23, 2026/)
	).toBeVisible();
	await calendar.getByRole("button", { name: "Agenda", exact: true }).click();
	await expect(
		calendar.getByText("Deployment workflow", { exact: true }).first()
	).toBeVisible();
	await expect(
		calendar.getByText("Core maintenance", { exact: true })
	).toHaveCount(0);
	await calendar.getByRole("button", { name: "Month", exact: true }).click();
	await expect(
		calendar.getByText("September 2026", { exact: true })
	).toBeVisible();
	await calendar.getByRole("button", { name: "Agenda", exact: true }).click();

	const systemJobsToggle = calendar.getByRole("button", {
		name: "Show system jobs",
	});
	await systemJobsToggle.click();
	await expect(systemJobsToggle).toHaveAttribute("aria-pressed", "true");
	await expect(
		calendar.getByText("Core maintenance", { exact: true }).first()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-agenda-system-jobs.png"),
	});

	await calendar.getByRole("button", { name: "Refresh" }).click();
	await expect
		.poll(
			async () =>
				coreRequest(await fixtureState(page), "GET", "/heartbeat/jobs").length
		)
		.toBeGreaterThan(1);
});

test("empty-state scheduling can be cancelled without creating a job", async ({
	page,
}) => {
	const calendar = await mountCalendar(page);
	await expect(
		calendar.getByText("No scheduled runs", { exact: true })
	).toBeVisible();
	await calendar
		.getByRole("button", { name: "New automation", exact: true })
		.first()
		.click();
	const dialog = calendar.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "New automation" })
	).toBeVisible();
	await expect(
		calendar.getByRole("combobox", { name: "Choose the agent to schedule" })
	).toContainText("Analyst");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).not.toBeVisible();
	const state = await fixtureState(page);
	expect(coreRequest(state, "POST", "/heartbeat/jobs")).toHaveLength(0);
	expect(state.jobs).toHaveLength(0);
	await calendar
		.getByRole("button", { name: "New automation", exact: true })
		.last()
		.click();
	await page.keyboard.press("Escape");
	await expect(calendar.getByRole("dialog")).not.toBeVisible();
	expect(
		coreRequest(await fixtureState(page), "POST", "/heartbeat/jobs")
	).toHaveLength(0);
});

test("all schedule controls persist the chosen agent, UTC times, and approval setting", async ({
	page,
}) => {
	const calendar = await mountCalendar(page);
	const scheduleCases: ScheduleCase[] = [
		{ value: "everyminute", expected: { kind: "every", interval: "1m" } },
		{ value: "hourly", expected: { kind: "every", interval: "1h" } },
		{
			value: "daily",
			set: async (dialog: Locator) =>
				dialog.getByLabel("Time (UTC)").fill("14:30"),
			expected: { kind: "cron", expr: "30 14 * * *" },
		},
		{
			value: "weekdays",
			set: async (dialog: Locator) =>
				dialog.getByLabel("Time (UTC)").fill("08:15"),
			expected: { kind: "cron", expr: "15 08 * * 1-5" },
		},
		{
			value: "weekends",
			set: async (dialog: Locator) =>
				dialog.getByLabel("Time (UTC)").fill("10:15"),
			expected: { kind: "cron", expr: "15 10 * * 0,6" },
		},
		{
			value: "weekly",
			set: async (dialog: Locator) => {
				await dialog.getByLabel("Day of week").selectOption("friday");
				await dialog.getByLabel("Time (UTC)").fill("07:45");
			},
			expected: { kind: "cron", expr: "45 07 * * 5" },
		},
		{
			value: "custom",
			set: async (dialog: Locator) =>
				dialog.getByLabel("Cron expression (UTC)").fill("*/10 * * * *"),
			expected: { kind: "cron", expr: "*/10 * * * *" },
		},
	];

	for (const [index, scenario] of scheduleCases.entries()) {
		await calendar
			.getByRole("button", { name: "New automation", exact: true })
			.last()
			.click();
		const dialog = calendar.getByRole("dialog");
		if (index === 0) {
			await calendar
				.getByRole("combobox", { name: "Choose the agent to schedule" })
				.click();
			await calendar.getByRole("option", { name: /Scheduler Two/ }).click();
			await dialog.getByRole("switch", { name: "Require my approval" }).click();
		}
		await dialog
			.getByLabel("Schedule", { exact: true })
			.selectOption(scenario.value);
		if (scenario.set) {
			await scenario.set(dialog);
		}
		if (index > 0) {
			await expect(
				dialog.getByRole("switch", { name: "Require my approval" })
			).toBeChecked();
		}
		await dialog.getByRole("button", { name: "Create automation" }).click();
		await expect(dialog).not.toBeVisible();
		const state = await fixtureState(page);
		const write = state.requests
			.filter(
				(request) =>
					(request.method === "POST" || request.method === "PUT") &&
					request.path.startsWith("/heartbeat/jobs")
			)
			.at(-1);
		expect(write).toBeDefined();
		expect(write?.method).toBe("POST");
		expect(write?.path).toBe("/heartbeat/jobs");
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]?.id).toBe("calendar-proof-job-1");
		expect(state.jobs[0]?.schedule).toEqual(scenario.expected);
		expect(write?.body).toEqual({
			enabled: true,
			name: "Scheduler Two (scheduled)",
			quick_routine: true,
			require_approval: true,
			schedule: scenario.expected,
			target: {
				agent_id: "agent-scheduler",
				prompt: "Run",
				type: "agent",
			},
		});
	}

	const saved = await fixtureState(page);
	expect(saved.jobs).toHaveLength(1);
	expect(saved.jobs[0]?.name).toBe("Scheduler Two (scheduled)");
	expect(saved.jobs[0]?.schedule).toEqual({
		kind: "cron",
		expr: "*/10 * * * *",
	});
	expect(saved.jobs[0]?.require_approval).toBe(true);
	expect(coreRequest(saved, "POST", "/heartbeat/jobs")).toHaveLength(
		scheduleCases.length
	);
	expect(
		coreRequest(saved, "PUT", "/heartbeat/jobs/calendar-proof-job-1")
	).toHaveLength(0);
	expect(
		saved.requests.every((request) =>
			request.path.startsWith("/__proof/")
				? true
				: request.authorization === "Bearer calendar-proof-node-token" &&
					request.userJwt === "calendar-proof-user-jwt"
		)
	).toBe(true);
	await page.reload();
	await page.waitForSelector('body[data-calendar-proof-ready="1"]');
	await page.evaluate(
		(appHtml) => window.__calendarProof.mount(appHtml),
		bundle
	);
	await expect
		.poll(() => page.evaluate(() => window.__calendarProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	const reloadedCalendar = page.frameLocator("#host-root iframe");
	await expect(
		reloadedCalendar.getByRole("button", { name: "Today" })
	).toBeVisible();
	await reloadedCalendar
		.getByRole("button", { name: "Agenda", exact: true })
		.click();
	await expect(
		reloadedCalendar
			.getByText("Scheduler Two (scheduled)", { exact: true })
			.first()
	).toBeVisible();
	await expect(
		reloadedCalendar.getByText("cron: */10 * * * *", { exact: true }).first()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"calendar-automation-schedules-persisted-after-reload.png"
		),
	});
});

test("rescheduling updates the existing routine and deletes only its generated legacy workflow", async ({
	page,
}) => {
	const current = job(
		"existing-routine",
		"Scheduler Two (scheduled)",
		{ type: "agent", agent_id: "agent-scheduler", prompt: "Run" },
		{ kind: "every", interval: "1h" },
		{
			enabled: false,
			history: [
				{
					started_at: "2026-09-22T09:00:00.000Z",
					finished_at: "2026-09-22T09:01:00.000Z",
					outcome: "success",
					run_id: "prior-routine-run",
				},
			],
			last_run_at: "2026-09-22T09:01:00.000Z",
			last_outcome: "success",
		}
	);
	const generatedWorkflow = workflow(
		"legacy-generated",
		"Scheduler Two (scheduled)",
		{
			nodes: [
				{ id: "input", type: "input" },
				{ id: "prompt", type: "prompt", agent_id: "agent-scheduler" },
				{ id: "output", type: "output" },
			],
			triggers: [{ type: "schedule", cron: "0 9 * * *" }],
		}
	);
	const userWorkflow = workflow("user-authored", "Scheduler Two (scheduled)", {
		nodes: [
			{ id: "input", type: "input" },
			{ id: "prompt", type: "prompt", agent_id: "agent-scheduler" },
			{ id: "audit", type: "tool" },
			{ id: "output", type: "output" },
		],
		triggers: [{ type: "schedule", cron: "0 9 * * *" }],
	});
	const calendar = await mountCalendar(page, {
		jobs: [current],
		createError: "The weekly schedule was rejected by Core.",
		createFailuresRemaining: 1,
		workflows: [generatedWorkflow, userWorkflow],
	});
	await calendar
		.getByRole("button", { name: "New automation", exact: true })
		.click();
	const dialog = calendar.getByRole("dialog");
	await calendar
		.getByRole("combobox", { name: "Choose the agent to schedule" })
		.click();
	await calendar.getByRole("option", { name: /Scheduler Two/ }).click();
	await dialog.getByLabel("Schedule", { exact: true }).selectOption("hourly");
	await dialog.getByRole("button", { name: "Create automation" }).click();
	await expect(
		dialog.getByText("The weekly schedule was rejected by Core.", {
			exact: true,
		})
	).toBeVisible();
	const failed = await fixtureState(page);
	expect(failed.jobs).toEqual([current]);
	expect(
		failed.requests.filter((request) => request.method === "DELETE")
	).toHaveLength(0);
	await expect(
		dialog.getByRole("button", { name: "Create automation" })
	).toBeEnabled();
	await dialog.getByRole("button", { name: "Create automation" }).click();
	await expect(dialog).not.toBeVisible();

	const saved = await fixtureState(page);
	const creates = coreRequest(saved, "POST", "/heartbeat/jobs");
	const updates = coreRequest(saved, "PUT", "/heartbeat/jobs/existing-routine");
	const deletes = saved.requests.filter(
		(request) =>
			request.method === "DELETE" && request.path.startsWith("/workflows/")
	);
	expect(creates).toHaveLength(2);
	expect(updates).toHaveLength(0);
	expect(creates[1]?.body).toEqual(creates[0]?.body);
	expect(creates[0]?.body).toEqual({
		quick_routine: true,
		enabled: true,
		name: "Scheduler Two (scheduled)",
		require_approval: false,
		schedule: { kind: "every", interval: "1h" },
		target: { agent_id: "agent-scheduler", prompt: "Run", type: "agent" },
	});
	expect(deletes.map(({ path: deletedPath }) => deletedPath)).toEqual([
		"/workflows/legacy-generated",
	]);
	expect(saved.jobs).toHaveLength(1);
	expect(saved.jobs[0]?.enabled).toBe(true);
	expect(saved.jobs[0]?.id).toBe(current.id);
	expect(saved.jobs[0]?.created_at).toBe(current.created_at);
	expect(saved.jobs[0]?.history).toEqual(current.history);
	expect(saved.jobs[0]?.last_run_at).toBe(current.last_run_at);
	expect(saved.jobs[0]?.last_outcome).toBe(current.last_outcome);
	expect(saved.workflows.map(({ id }) => id)).toEqual(["user-authored"]);
});
