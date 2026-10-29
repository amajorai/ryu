import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const PROOF_PAGE = "/calendar-automation-proof.html";
const NOW = "2026-10-01T08:00:00.000Z";

type ScheduleWire =
	| { expr: string; kind: "cron"; tz?: string }
	| { interval: string; kind: "every" };

interface AgentTargetWire {
	agent_id: string;
	conversation_id?: string | null;
	prompt: string;
	type: "agent";
}

interface CreateJobBody {
	quick_routine?: boolean;
	enabled: boolean;
	name: string;
	require_approval: boolean;
	schedule: ScheduleWire;
	target: AgentTargetWire;
}

interface UpdateJobBody {
	enabled?: boolean;
	name?: string;
	require_approval?: boolean;
	schedule?: ScheduleWire;
	target?: AgentTargetWire;
}

interface StoredJob extends CreateJobBody {
	created_at: string;
	history: unknown[];
	id: string;
	last_outcome: "success" | "failure" | null;
	last_run_at: string | null;
	owner_app: string | null;
	updated_at: string;
}

interface CapturedWrite {
	body: CreateJobBody | UpdateJobBody;
	method: "POST" | "PUT";
	path: string;
}

interface FailureResponse {
	cron?: string;
	error: string;
	method: "POST" | "PUT";
	status: number;
}

interface CoreFixture {
	failures?: FailureResponse[];
}

interface CoreFixtureState {
	protocol: Array<{
		event: "accepted-write" | "read-request";
		method: string;
		path: string;
		status?: number;
	}>;
	jobReads: StoredJob[][];
	jobs: StoredJob[];
	writes: CapturedWrite[];
}

function jsonResponse<FixturePayload>(body: FixturePayload, status = 200) {
	return {
		body: JSON.stringify(body),
		contentType: "application/json",
		status,
	};
}

function takeFailure(
	failures: FailureResponse[],
	method: FailureResponse["method"],
	body?: CreateJobBody | UpdateJobBody
): FailureResponse | undefined {
	const index = failures.findIndex(
		(failure) =>
			failure.method === method &&
			(failure.cron === undefined ||
				(body?.schedule?.kind === "cron" &&
					body.schedule.expr === failure.cron))
	);
	if (index < 0) {
		return undefined;
	}
	return failures.splice(index, 1)[0];
}

function makeStoredJob(body: CreateJobBody, id: string): StoredJob {
	// The request-only quick slot flag is not part of Core's saved job DTO.
	const { quick_routine: _quickRoutine, ...stored } = body;
	const target = { ...stored.target };
	if (target.conversation_id === null) delete target.conversation_id;
	return {
		...stored,
		target,
		created_at: NOW,
		history: [],
		id,
		last_outcome: null,
		last_run_at: null,
		owner_app: null,
		updated_at: NOW,
	};
}

async function installCoreFixture(
	page: Page,
	{ failures = [] }: CoreFixture = {}
): Promise<CoreFixtureState> {
	const state: CoreFixtureState = {
		jobReads: [],
		jobs: [],
		writes: [],
		protocol: [],
	};
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && path === "/heartbeat/jobs") {
			state.protocol.push({ event: "read-request", method: "GET", path });
		}
	});
	page.on("response", (response) => {
		const method = response.request().method();
		const path = new URL(response.url()).pathname;
		if (
			(method === "POST" || method === "PUT") &&
			path.startsWith("/heartbeat/jobs") &&
			response.ok()
		) {
			state.protocol.push({
				event: "accepted-write",
				method,
				path,
				status: response.status(),
			});
		}
	});
	const failureQueue = [...failures];

	await page.route("**/heartbeat/jobs**", async (route) => {
		const request = route.request();
		const { pathname } = new URL(request.url());
		const method = request.method();

		if (method === "GET" && pathname === "/heartbeat/jobs") {
			state.jobReads.push(structuredClone(state.jobs));
			await route.fulfill(jsonResponse({ jobs: state.jobs }));
			return;
		}

		if (method === "POST" && pathname === "/heartbeat/jobs") {
			const body = request.postDataJSON();
			state.writes.push({
				body: structuredClone(body),
				method,
				path: pathname,
			});
			const failure = takeFailure(failureQueue, method, body);
			if (failure) {
				await route.fulfill(
					jsonResponse({ success: false, error: failure.error }, failure.status)
				);
				return;
			}

			// This finite fixture has one owner/node: Core's quick slot is per agent.
			const existing = body.quick_routine
				? state.jobs.findIndex(
						(job) => job.target.agent_id === body.target.agent_id
					)
				: -1;
			const previous = state.jobs[existing];
			const job = makeStoredJob(
				body,
				previous?.id ?? `job-proof-${state.jobs.length + 1}`
			);
			if (previous) {
				job.created_at = previous.created_at;
				job.history = previous.history;
				state.jobs[existing] = job;
			} else state.jobs.push(job);
			await route.fulfill(jsonResponse({ success: true, job }));
			return;
		}

		if (method === "PUT" && pathname.startsWith("/heartbeat/jobs/")) {
			const body = request.postDataJSON();
			state.writes.push({
				body: structuredClone(body),
				method,
				path: pathname,
			});
			const failure = takeFailure(failureQueue, method, body);
			if (failure) {
				await route.fulfill(
					jsonResponse({ success: false, error: failure.error }, failure.status)
				);
				return;
			}

			const id = decodeURIComponent(pathname.split("/").at(-1) ?? "");
			const index = state.jobs.findIndex((job) => job.id === id);
			const current = state.jobs[index];
			if (!current || index < 0) {
				await route.fulfill(
					jsonResponse({ success: false, error: "job not found" }, 404)
				);
				return;
			}
			const updated: StoredJob = {
				...current,
				...body,
				name: body.name ?? current.name,
				schedule: body.schedule ?? current.schedule,
				target: body.target ?? current.target,
				enabled: body.enabled ?? current.enabled,
				require_approval: body.require_approval ?? current.require_approval,
				updated_at: NOW,
			};
			state.jobs[index] = updated;
			await route.fulfill(jsonResponse({ success: true, job: updated }));
			return;
		}

		await route.fulfill(
			jsonResponse(
				{ error: `Unexpected jobs request: ${method} ${pathname}` },
				404
			)
		);
	});

	await page.route("**/workflows", async (route) => {
		const request = route.request();
		if (request.method() === "GET") {
			await route.fulfill(jsonResponse({ workflows: [] }));
			return;
		}
		await route.fulfill(
			jsonResponse(
				{ error: `Unexpected workflow request: ${request.method()}` },
				404
			)
		);
	});

	return state;
}

async function openNewAutomation(page: Page): Promise<void> {
	await expect(
		page.getByRole("button", { name: "New automation", exact: true }).first()
	).toBeVisible();
	await page
		.getByRole("button", { name: "New automation", exact: true })
		.first()
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
}

const makeScreenshot = async (page: Page, fileName: string): Promise<void> => {
	const screenshotPath = path.resolve(
		import.meta.dirname,
		`harness/proof/${fileName}`
	);
	await mkdir(path.dirname(screenshotPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath,
	});
};

test("creates a UTC daily agent schedule, retains a failed draft, retries, and reads it back", async ({
	page,
}) => {
	await page.clock.install({ time: new Date(NOW) });
	const core = await installCoreFixture(page, {
		failures: [
			{
				method: "POST",
				status: 500,
				error: "Scheduled-job storage is temporarily unavailable.",
			},
		],
	});
	await page.goto(PROOF_PAGE);
	await openNewAutomation(page);

	await expect(page.getByLabel("Agent")).toHaveValue("agent-daily");
	await expect(page.getByLabel("Schedule")).toHaveValue("daily");
	await expect(page.getByLabel("Time (UTC)")).toHaveValue("09:00");
	await page.getByLabel("Time (UTC)").fill("14:35");
	await expect(page.getByLabel("Transcript destination")).toHaveValue("new");
	const approvalSwitch = page.getByRole("switch", {
		name: "Ask before each run",
	});
	await approvalSwitch.click();
	await expect(approvalSwitch).toBeChecked();

	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(
		page.getByText("Scheduled-job storage is temporarily unavailable.", {
			exact: true,
		})
	).toBeVisible();
	await expect(page.getByLabel("Time (UTC)")).toHaveValue("14:35");
	await expect(approvalSwitch).toBeChecked();
	await expect(core.writes).toHaveLength(1);
	expect(core.jobs).toEqual([]);
	const expectedBody: CreateJobBody = {
		enabled: true,
		name: "Daily Brief (scheduled)",
		quick_routine: true,
		require_approval: true,
		schedule: { expr: "35 14 * * *", kind: "cron" },
		target: {
			agent_id: "agent-daily",
			conversation_id: null,
			prompt: "Run",
			type: "agent",
		},
	};
	await expect(core.writes[0]).toEqual({
		body: expectedBody,
		method: "POST",
		path: "/heartbeat/jobs",
	});

	const readsBeforeSave = core.jobReads.length;
	const protocolBeforeSave = core.protocol.length;
	const freshRead = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/heartbeat/jobs" &&
			response.request().method() === "GET" &&
			response.ok()
	);
	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(
		page.getByRole("button", { name: /Daily Brief \(scheduled\)/ }).first()
	).toBeVisible();
	await expect(core.writes).toHaveLength(2);
	await expect(core.writes[1]).toEqual(core.writes[0]);
	const persistedReadback = await (await freshRead).json();
	expect(persistedReadback).toEqual({
		jobs: [
			{
				created_at: NOW,
				enabled: true,
				history: [],
				id: "job-proof-1",
				last_outcome: null,
				last_run_at: null,
				name: "Daily Brief (scheduled)",
				owner_app: null,
				require_approval: true,
				schedule: { expr: "35 14 * * *", kind: "cron" },
				target: { agent_id: "agent-daily", prompt: "Run", type: "agent" },
				updated_at: NOW,
			},
		],
	});
	expect(core.jobReads.length).toBeGreaterThan(readsBeforeSave);
	const accepted = core.protocol
		.slice(protocolBeforeSave)
		.findIndex(
			(event) =>
				event.event === "accepted-write" &&
				event.method === "POST" &&
				event.path === "/heartbeat/jobs" &&
				event.status === 200
		);
	expect(accepted).toBeGreaterThanOrEqual(0);
	expect(core.protocol.slice(protocolBeforeSave + accepted + 1)).toContainEqual(
		{ event: "read-request", method: "GET", path: "/heartbeat/jobs" }
	);

	await makeScreenshot(page, "calendar-automation-create-proof.png");
});

test("changes agent, transcript chat, and weekly UTC day/time in the Calendar routine", async ({
	page,
}) => {
	await page.clock.install({ time: new Date("2026-10-01T06:00:00.000Z") });
	const core = await installCoreFixture(page);
	await page.goto(`${PROOF_PAGE}?agent=agent-release`);
	await openNewAutomation(page);

	const agentSelect = page.getByLabel("Agent");
	await expect(agentSelect).toHaveValue("agent-release");
	await page.getByLabel("Schedule").selectOption("weekly");
	await page.getByLabel("Day").selectOption("thursday");
	await page.getByLabel("Time (UTC)").fill("07:45");
	await page.getByLabel("Transcript destination").selectOption("existing");
	const chatSelect = page.getByLabel("Persistent chat");
	await expect(chatSelect).toHaveValue("chat-release-primary");
	await chatSelect.selectOption("chat-release-secondary");
	await expect(chatSelect).toHaveValue("chat-release-secondary");
	await agentSelect.selectOption("agent-daily");
	await expect(agentSelect).toHaveValue("agent-daily");
	await expect(chatSelect).toHaveValue("chat-daily-primary");
	await agentSelect.selectOption("agent-release");
	await expect(agentSelect).toHaveValue("agent-release");
	await expect(chatSelect).toHaveValue("chat-release-primary");
	await chatSelect.selectOption("chat-release-secondary");
	await expect(chatSelect).toHaveValue("chat-release-secondary");
	await expect(
		page.getByText("Every firing appends to the selected chat.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Ask before each run" })
	).not.toBeChecked();

	const readsBeforeSave = core.jobReads.length;
	const protocolBeforeSave = core.protocol.length;
	const freshRead = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/heartbeat/jobs" &&
			response.request().method() === "GET" &&
			response.ok()
	);
	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(
		page.getByRole("button", { name: /Release Watch \(scheduled\)/ }).first()
	).toBeVisible();
	const expectedBody = {
		enabled: true,
		name: "Release Watch (scheduled)",
		quick_routine: true,
		require_approval: false,
		schedule: { expr: "45 07 * * 4", kind: "cron" },
		target: {
			agent_id: "agent-release",
			conversation_id: "chat-release-secondary",
			prompt: "Run",
			type: "agent",
		},
	} satisfies CreateJobBody;
	await expect(core.writes).toHaveLength(1);
	await expect(core.writes[0]).toEqual({
		body: expectedBody,
		method: "POST",
		path: "/heartbeat/jobs",
	});
	const persistedReadback = await (await freshRead).json();
	expect(persistedReadback).toEqual({
		jobs: [
			{
				created_at: NOW,
				enabled: true,
				history: [],
				id: "job-proof-1",
				last_outcome: null,
				last_run_at: null,
				name: "Release Watch (scheduled)",
				owner_app: null,
				require_approval: false,
				schedule: { expr: "45 07 * * 4", kind: "cron" },
				target: {
					agent_id: "agent-release",
					conversation_id: "chat-release-secondary",
					prompt: "Run",
					type: "agent",
				},
				updated_at: NOW,
			},
		],
	});
	expect(core.jobReads.length).toBeGreaterThan(readsBeforeSave);
	const accepted = core.protocol
		.slice(protocolBeforeSave)
		.findIndex(
			(event) =>
				event.event === "accepted-write" &&
				event.method === "POST" &&
				event.path === "/heartbeat/jobs" &&
				event.status === 200
		);
	expect(accepted).toBeGreaterThanOrEqual(0);
	expect(core.protocol.slice(protocolBeforeSave + accepted + 1)).toContainEqual(
		{ event: "read-request", method: "GET", path: "/heartbeat/jobs" }
	);

	await makeScreenshot(page, "calendar-automation-persistent-chat-proof.png");
});

test("creates intervals, surfaces Core cron validation, and discards drafts on Cancel or Escape", async ({
	page,
}) => {
	await page.clock.install({ time: new Date(NOW) });
	const core = await installCoreFixture(page, {
		failures: [
			{
				method: "POST",
				cron: "not a cron",
				status: 400,
				error: "Invalid cron expression: expected five fields.",
			},
		],
	});
	await page.goto(PROOF_PAGE);
	await openNewAutomation(page);
	await page.getByLabel("Schedule").selectOption("hourly");
	await expect(page.getByLabel("Time (UTC)")).toHaveCount(0);
	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(
		page.getByRole("button", { name: /Daily Brief \(scheduled\)/ }).first()
	).toBeVisible();
	await expect(core.writes[0]).toEqual({
		body: {
			enabled: true,
			name: "Daily Brief (scheduled)",
			quick_routine: true,
			require_approval: false,
			schedule: { interval: "1h", kind: "every" },
			target: {
				agent_id: "agent-daily",
				conversation_id: null,
				prompt: "Run",
				type: "agent",
			},
		},
		method: "POST",
		path: "/heartbeat/jobs",
	});

	await openNewAutomation(page);
	await page.getByLabel("Schedule").selectOption("custom");
	const cronField = page.getByLabel("Cron expression (UTC)");
	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(
		page.getByText("Enter a cron expression.", { exact: true })
	).toBeVisible();
	await expect(core.writes).toHaveLength(1);

	await cronField.fill("not a cron");
	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(
		page.getByText("Invalid cron expression: expected five fields.", {
			exact: true,
		})
	).toBeVisible();
	await expect(cronField).toHaveValue("not a cron");
	await expect(core.writes).toHaveLength(2);
	await expect(core.writes[1]).toEqual({
		body: {
			enabled: true,
			name: "Daily Brief (scheduled)",
			quick_routine: true,
			require_approval: false,
			schedule: { expr: "not a cron", kind: "cron" },
			target: {
				agent_id: "agent-daily",
				conversation_id: null,
				prompt: "Run",
				type: "agent",
			},
		},
		method: "POST",
		path: "/heartbeat/jobs",
	});

	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	await openNewAutomation(page);
	await expect(
		page.getByText("Invalid cron expression: expected five fields.")
	).toHaveCount(0);
	await expect(page.getByLabel("Schedule")).toHaveValue("daily");
	await expect(page.getByLabel("Time (UTC)")).toHaveValue("09:00");
	await expect(page.getByLabel("Transcript destination")).toHaveValue("new");
	await expect(
		page.getByRole("switch", { name: "Ask before each run" })
	).not.toBeChecked();

	await page.getByLabel("Schedule").selectOption("weekends");
	await page.getByLabel("Time (UTC)").fill("18:20");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await openNewAutomation(page);
	await expect(page.getByLabel("Schedule")).toHaveValue("daily");
	await expect(page.getByLabel("Time (UTC)")).toHaveValue("09:00");
	await expect(page.getByLabel("Transcript destination")).toHaveValue("new");

	await page.getByLabel("Schedule").selectOption("custom");
	await page.getByLabel("Cron expression (UTC)").fill("15 8 * * 1-5");
	await page.getByRole("button", { name: "Create automation" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(
		page.getByRole("button", { name: /Daily Brief \(scheduled\)/ }).first()
	).toBeVisible();
	await expect(core.writes).toHaveLength(3);
	await expect(core.writes[2]).toEqual({
		body: {
			enabled: true,
			name: "Daily Brief (scheduled)",
			quick_routine: true,
			require_approval: false,
			schedule: { expr: "15 8 * * 1-5", kind: "cron" },
			target: {
				agent_id: "agent-daily",
				conversation_id: null,
				prompt: "Run",
				type: "agent",
			},
		},
		method: "POST",
		path: "/heartbeat/jobs",
	});
	await expect
		.poll(() => core.jobReads.at(-1)?.[0]?.schedule)
		.toEqual({ expr: "15 8 * * 1-5", kind: "cron" });
	expect(core.jobs).toHaveLength(1);
	expect(core.jobs[0]?.id).toBe("job-proof-1");
	expect(core.jobReads.at(-1)?.[0]).toMatchObject({
		name: "Daily Brief (scheduled)",
		schedule: { expr: "15 8 * * 1-5", kind: "cron" },
	});
});
