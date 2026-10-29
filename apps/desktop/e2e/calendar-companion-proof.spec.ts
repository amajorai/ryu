import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
	expect,
	type FrameLocator,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { z } from "zod";
import type { CalendarProofApi } from "./calendar-companion-proof/calendar-companion-proof.tsx";
import type { ProofJsonRecord } from "./fixture-json.ts";

const bundlePath = path.resolve(
	import.meta.dirname,
	"../../core/src/plugin_manifest/fixtures/calendar.ui.html"
);
const bundle = readFileSync(bundlePath, "utf8");
const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const proofTime = new Date("2026-09-23T12:00:00.000Z");
const rangeAnchor = "2026-09-23T12:00:00.000Z";

interface JobWire {
	created_at: string;
	enabled?: boolean;
	history?: unknown[];
	id: string;
	last_outcome?: string | null;
	last_run_at?: string | null;
	name: string;
	owner_app?: string | null;
	require_approval?: boolean;
	schedule: ProofJsonRecord;
	target: ProofJsonRecord;
	updated_at: string;
}

interface WorkflowWire {
	edges: unknown[];
	id: string;
	name: string;
	nodes: ProofJsonRecord[];
	triggers: ProofJsonRecord[];
}

interface CapturedRequest {
	authorization: string | null;
	body: ProofJsonRecord | null;
	method: string;
	path: string;
	userJwt: string | null;
}

interface FixtureState {
	createError: string;
	createFailuresRemaining: number;
	jobReadFailuresRemaining: number;
	jobs: JobWire[];
	requests: CapturedRequest[];
	updateError: string;
	updateFailuresRemaining: number;
	workflows: WorkflowWire[];
}

declare global {
	interface Window {
		__calendarProof: CalendarProofApi;
	}
}

function job(
	id: string,
	name: string,
	target: ProofJsonRecord,
	schedule: ProofJsonRecord,
	extra: Partial<JobWire> = {}
): JobWire {
	return {
		created_at: rangeAnchor,
		enabled: true,
		history: [],
		id,
		last_outcome: null,
		last_run_at: null,
		name,
		require_approval: false,
		schedule,
		target,
		updated_at: rangeAnchor,
		...extra,
	};
}

function workflow(
	id: string,
	name: string,
	options: Partial<WorkflowWire> = {}
): WorkflowWire {
	return {
		edges: [],
		id,
		name,
		nodes: [],
		triggers: [],
		...options,
	};
}

const JobSchema = z.object({
	created_at: z.string(),
	enabled: z.boolean().optional(),
	history: z.array(z.json()).optional(),
	id: z.string(),
	last_outcome: z.string().nullable().optional(),
	last_run_at: z.string().nullable().optional(),
	name: z.string(),
	owner_app: z.string().nullable().optional(),
	require_approval: z.boolean().optional(),
	schedule: z.record(z.string(), z.json()),
	target: z.record(z.string(), z.json()),
	updated_at: z.string(),
});
const WorkflowSchema = z.object({
	edges: z.array(z.json()),
	id: z.string(),
	name: z.string(),
	nodes: z.array(z.record(z.string(), z.json())),
	triggers: z.array(z.record(z.string(), z.json())),
});
const FixtureSchema = z.object({
	createError: z.string(),
	createFailuresRemaining: z.number(),
	jobReadFailuresRemaining: z.number(),
	jobs: JobSchema.array(),
	requests: z.array(
		z.object({
			authorization: z.string().nullable(),
			body: z.record(z.string(), z.json()).nullable(),
			method: z.string(),
			path: z.string(),
			userJwt: z.string().nullable(),
		})
	),
	updateError: z.string(),
	updateFailuresRemaining: z.number(),
	workflows: WorkflowSchema.array(),
}) satisfies z.ZodType<FixtureState>;

async function fixtureState(page: Page): Promise<FixtureState> {
	const state = await page.evaluate(async () => {
		const response = await fetch("/__proof/state");
		if (!response.ok) {
			throw new Error(`Fixture state request failed: ${response.status}`);
		}
		return await response.json();
	});
	return FixtureSchema.parse(state);
}

async function mountCalendar(
	page: Page,
	fixture: {
		createError?: string;
		createFailuresRemaining?: number;
		jobs?: JobWire[];
		jobReadFailuresRemaining?: number;
		updateError?: string;
		updateFailuresRemaining?: number;
		workflows?: WorkflowWire[];
	} = {}
): Promise<FrameLocator> {
	const startupErrors: string[] = [];
	page.on("pageerror", (error) => startupErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			startupErrors.push(message.text());
		}
	});
	page.on("requestfailed", (request) => {
		startupErrors.push(
			`${request.method()} ${request.url()}: ${request.failure()?.errorText}`
		);
	});
	await page.clock.setFixedTime(proofTime);
	await page.goto("/calendar-companion-proof.html");
	try {
		await page.waitForSelector('body[data-calendar-proof-ready="1"]', {
			timeout: 10_000,
		});
	} catch (error) {
		const html = await page.locator("body").innerHTML();
		throw new Error(
			`Calendar harness boot failed: ${String(error)}; errors=${startupErrors.join(" | ")}; body=${html}`
		);
	}
	const reset = await page.evaluate(async (serializedState) => {
		const response = await fetch("/__proof/reset", {
			body: serializedState,
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
		return response.ok;
	}, JSON.stringify(fixture));
	expect(reset).toBe(true);
	await page.evaluate(
		(appHtml) => window.__calendarProof.mount(appHtml),
		bundle
	);
	await expect
		.poll(() => page.evaluate(() => window.__calendarProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	const calendar = page.frameLocator("#host-root iframe");
	if ((fixture.jobReadFailuresRemaining ?? 0) > 0) {
		await expect(
			calendar.getByText("Could not load calendar", { exact: true })
		).toBeVisible();
	} else {
		await expect(calendar.getByRole("button", { name: "Today" })).toBeVisible();
	}
	return calendar;
}

function coreRequest(
	state: FixtureState,
	method: string,
	path: string
): CapturedRequest[] {
	return state.requests.filter(
		(request) => request.method === method && request.path === path
	);
}

async function expectButtonWithinCell(button: Locator, cell: Locator) {
	const [buttonBox, cellBox] = await Promise.all([
		button.boundingBox(),
		cell.boundingBox(),
	]);
	expect(buttonBox).not.toBeNull();
	expect(cellBox).not.toBeNull();
	if (buttonBox && cellBox) {
		expect(buttonBox.x).toBeGreaterThanOrEqual(cellBox.x);
		expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
			cellBox.x + cellBox.width + 1
		);
	}
}

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

interface ScheduleCase {
	expected: Record<string, string>;
	set?: (dialog: Locator) => ReturnType<Locator["fill"]>;
	value: string;
}

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
				await dialog.getByLabel("Day").selectOption("friday");
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

test("invalid custom cron stays editable after backend rejection and a corrected retry persists", async ({
	page,
}) => {
	const serverMessage = "Invalid cron expression: expected 5 fields.";
	const calendar = await mountCalendar(page, {
		createError: serverMessage,
		createFailuresRemaining: 1,
	});
	await calendar
		.getByRole("button", { name: "New automation", exact: true })
		.last()
		.click();
	const dialog = calendar.getByRole("dialog");
	await dialog.getByLabel("Schedule", { exact: true }).selectOption("custom");
	const createButton = dialog.getByRole("button", {
		name: "Create automation",
	});
	await createButton.click();
	await expect(
		dialog.getByText("Enter a cron expression.", { exact: true })
	).toBeVisible();
	expect(
		coreRequest(await fixtureState(page), "POST", "/heartbeat/jobs")
	).toHaveLength(0);

	const cronInput = dialog.getByLabel("Cron expression (UTC)");
	await cronInput.fill("61 * * * *");
	await createButton.click();
	await expect(dialog.getByText(serverMessage, { exact: true })).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(cronInput).toHaveValue("61 * * * *");
	await expect(createButton).toBeEnabled();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-invalid-cron-recoverable.png"),
	});

	await cronInput.fill("*/15 * * * *");
	await createButton.click();
	await expect(dialog).not.toBeVisible();
	const saved = await fixtureState(page);
	expect(coreRequest(saved, "POST", "/heartbeat/jobs")).toHaveLength(2);
	expect(saved.jobs).toHaveLength(1);
	expect(saved.jobs[0]?.schedule).toEqual({
		kind: "cron",
		expr: "*/15 * * * *",
	});
});

test("failed initial load exposes retry and refresh updates the visible run list", async ({
	page,
}) => {
	const initialJob = job(
		"routine-before",
		"Previous routine",
		{ type: "agent", agent_id: "agent-analyst", prompt: "Run" },
		{ kind: "every", interval: "1d" }
	);
	const calendar = await mountCalendar(page, {
		jobs: [initialJob],
		jobReadFailuresRemaining: 1,
	});
	await expect(
		calendar.getByText("Could not load calendar", { exact: true })
	).toBeVisible();
	await calendar.getByRole("button", { name: "Try again" }).click();
	await expect(
		calendar.getByRole("button", { name: /Previous routine/ }).first()
	).toBeVisible();
	const afterRetry = await fixtureState(page);
	expect(coreRequest(afterRetry, "GET", "/heartbeat/jobs")).toHaveLength(2);

	const updatedJob = job(
		"routine-after",
		"Updated persisted routine",
		{ type: "agent", agent_id: "agent-analyst", prompt: "Run" },
		{ kind: "every", interval: "1d" }
	);
	const replace = await page.evaluate(
		async (serializedJobs) => {
			const response = await fetch("/__proof/replace-jobs", {
				body: serializedJobs,
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			return response.ok;
		},
		JSON.stringify({ jobs: [updatedJob] })
	);
	expect(replace).toBe(true);
	await calendar.getByRole("button", { name: "Refresh" }).click();
	await expect(
		calendar.getByRole("button", { name: /Updated persisted routine/ }).first()
	).toBeVisible();
	await expect(
		calendar.getByRole("button", { name: /Previous routine/ })
	).toHaveCount(0);
	const refreshed = await fixtureState(page);
	expect(coreRequest(refreshed, "GET", "/heartbeat/jobs")).toHaveLength(3);
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "calendar-load-retry-refresh-result.png"),
	});
});
