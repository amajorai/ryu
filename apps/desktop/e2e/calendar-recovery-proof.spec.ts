import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const PROOF_PAGE = "/calendar-recovery-proof.html";
const NOW = "2026-10-01T08:00:00.000Z";
const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence"
);
interface JobBody {
	enabled: boolean;
	name: string;
	require_approval: boolean;
	schedule: { kind: "cron"; expr: string };
	target: {
		type: "agent";
		agent_id: string;
		prompt: string;
		conversation_id?: string;
	};
}
interface CreateJobBody extends Omit<JobBody, "target"> {
	quick_routine: true;
	target: Omit<JobBody["target"], "conversation_id"> & {
		conversation_id?: string | null;
	};
}
interface StoredJob extends JobBody {
	created_at: string;
	history: unknown[];
	id: string;
	updated_at: string;
}
interface CapturedRequest {
	authorization: string | undefined;
	body: unknown;
	delegation: string | undefined;
	method: string;
	pathname: string;
	search: string;
}
interface ReadPlan {
	delay?: Promise<void>;
	status: number;
}
interface CalendarRecoveryFixtureState {
	jobs: StoredJob[];
	reads: StoredJob[][];
	requests: CapturedRequest[];
}
function job(name = "Daily Brief saved", agentId = "agent-daily"): StoredJob {
	return {
		enabled: true,
		name,
		require_approval: false,
		schedule: { kind: "cron", expr: "0 9 * * *" },
		target: { type: "agent", agent_id: agentId, prompt: "Run" },
		id: agentId,
		created_at: NOW,
		updated_at: NOW,
		history: [],
	};
}
function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
async function fixture(
	page: Page,
	jobs: StoredJob[] = [],
	plans: ReadPlan[] = []
) {
	const state: CalendarRecoveryFixtureState = {
		jobs: structuredClone(jobs),
		requests: [],
		reads: [],
	};
	await page.route("**/selected-core/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		state.requests.push({
			method: request.method(),
			pathname: url.pathname,
			search: url.search,
			authorization: request.headers().authorization,
			delegation: request.headers()["x-ryu-user-jwt"],
			body: request.postData() ? request.postDataJSON() : null,
		});
		let body: Parameters<typeof JSON.stringify>[0];
		let status = 200;
		if (
			request.method() === "GET" &&
			url.pathname === "/selected-core/heartbeat/jobs"
		) {
			const plan = plans.shift();
			if (plan?.delay) {
				await plan.delay;
			}
			status = plan?.status ?? 200;
			if (status === 200) {
				state.reads.push(structuredClone(state.jobs));
				body = { jobs: state.jobs };
			} else {
				body = { error: "Fixture storage unavailable" };
			}
		} else if (
			request.method() === "GET" &&
			url.pathname === "/selected-core/workflows"
		) {
			body = { workflows: [] };
		} else if (
			request.method() === "POST" &&
			url.pathname === "/selected-core/heartbeat/jobs"
		) {
			const input = request.postDataJSON() as CreateJobBody;
			expect(input.quick_routine).toBe(true);
			const candidates = state.jobs.filter(
				(candidate) =>
					candidate.name.endsWith(" (scheduled)") &&
					candidate.target.agent_id === input.target.agent_id
			);
			expect(candidates.length).toBeLessThanOrEqual(1);
			const previous = candidates[0];
			// quick_routine selects Core's atomic slot and is not a stored DTO
			// property. An explicitly cleared conversation serializes as absent.
			const created: StoredJob = {
				...previous,
				enabled: input.enabled,
				name: input.name,
				require_approval: input.require_approval,
				schedule: input.schedule,
				target: {
					type: input.target.type,
					agent_id: input.target.agent_id,
					prompt: input.target.prompt,
				},
				id: previous?.id ?? "created-calendar-routine",
				created_at: previous?.created_at ?? NOW,
				updated_at: NOW,
				history: previous?.history ?? [],
			};
			if (typeof input.target.conversation_id === "string") {
				created.target.conversation_id = input.target.conversation_id;
			} else if (
				input.target.conversation_id === undefined &&
				previous?.target.conversation_id !== undefined
			) {
				created.target.conversation_id = previous.target.conversation_id;
			}
			if (previous) {
				state.jobs[state.jobs.indexOf(previous)] = created;
			} else {
				state.jobs.push(created);
			}
			body = { success: true, job: created };
		} else {
			status = 404;
			body = { error: "Unexpected fixture request" };
		}
		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	return state;
}
function assertTransport(requests: CapturedRequest[]) {
	expect(requests.length).toBeGreaterThan(0);
	for (const request of requests) {
		expect(request.authorization).toBe("Bearer calendar-node-fixture");
		expect(request.delegation).toBe("calendar-delegation-fixture");
		// The job list opts in to the jobs Core reconciles for apps; nothing else
		// carries a query.
		const listsJobs =
			request.method === "GET" &&
			request.pathname === "/selected-core/heartbeat/jobs";
		expect(request.search).toBe(listsJobs ? "?include=app_jobs" : "");
		expect([
			"/selected-core/heartbeat/jobs",
			"/selected-core/workflows",
		]).toContain(request.pathname);
		if (request.method === "GET") {
			expect(request.body).toBeNull();
		}
	}
}
async function screenshot(page: Page, filename: string) {
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({
		path: path.join(EVIDENCE, filename),
		fullPage: true,
		animations: "disabled",
	});
}

test("initial schedules failure exposes retry and reads only the saved agent from the selected node", async ({
	page,
}) => {
	await page.clock.install({ time: new Date(NOW) });
	const core = await fixture(
		page,
		[job(), job("Release only", "agent-release")],
		[{ status: 503 }]
	);
	await page.goto(PROOF_PAGE);
	await expect(
		page.getByText("Could not load calendar", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Try again", exact: true })
	).toBeVisible();
	await screenshot(page, "calendar-recovery-initial-error.png");
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /Daily Brief saved/ }).first()
	).toBeVisible();
	await expect(page.getByRole("button", { name: /Release only/ })).toHaveCount(
		0
	);
	await expect(
		page.getByText("Could not load calendar", { exact: true })
	).toHaveCount(0);
	expect(
		core.requests.filter((r) => r.pathname.endsWith("/heartbeat/jobs"))
	).toHaveLength(2);
	expect(
		core.requests.filter((r) => r.pathname.endsWith("/workflows"))
	).toHaveLength(1);
	expect(core.reads).toEqual([core.jobs]);
	assertTransport(core.requests);
	await screenshot(page, "calendar-recovery-initial-recovered.png");
});

test("refresh preserves saved calendar while loading, reads changes back and recovers a refresh failure", async ({
	page,
}) => {
	await page.clock.install({ time: new Date(NOW) });
	const hold = deferred();
	const core = await fixture(
		page,
		[job()],
		[
			{ status: 200 },
			{ status: 200, delay: hold.promise },
			{ status: 503 },
			{ status: 200 },
		]
	);
	await page.goto(PROOF_PAGE);
	const saved = page.getByRole("button", { name: /Daily Brief saved/ }).first();
	await expect(saved).toBeVisible();
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect
		.poll(
			() =>
				core.requests.filter((r) => r.pathname.endsWith("/heartbeat/jobs"))
					.length
		)
		.toBe(2);
	await expect(
		page.getByRole("button", { name: "Refresh", exact: true })
	).toBeDisabled();
	await expect(saved).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Today", exact: true })
	).toBeVisible();
	await screenshot(page, "calendar-recovery-refresh-loading.png");
	core.jobs[0] = job("Daily Brief updated in storage");
	hold.release();
	await expect(
		page.getByRole("button", { name: /Daily Brief updated in storage/ }).first()
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Refresh", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(
		page.getByText("Could not load calendar", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /Daily Brief updated in storage/ }).first()
	).toBeVisible();
	expect(core.reads.map((jobs) => jobs[0]?.name)).toEqual([
		"Daily Brief saved",
		"Daily Brief updated in storage",
		"Daily Brief updated in storage",
	]);
	expect(
		core.requests.filter((r) => r.pathname.endsWith("/heartbeat/jobs"))
	).toHaveLength(4);
	assertTransport(core.requests);
	await screenshot(page, "calendar-recovery-refresh-recovered.png");
});

test("reachable New automation cancels without writing then creates and reloads canonical saved schedule", async ({
	page,
}) => {
	await page.clock.install({ time: new Date(NOW) });
	const core = await fixture(page);
	await page.goto(PROOF_PAGE);
	await expect(
		page.getByText("No automations scheduled", { exact: true })
	).toBeVisible();
	const open = page
		.getByRole("button", { name: "New automation", exact: true })
		.first();
	await open.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByLabel("Agent")).toHaveValue("agent-daily");
	await page.getByLabel("Time (UTC)").fill("15:25");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeHidden();
	expect(core.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	await open.click();
	await expect(page.getByLabel("Time (UTC)")).toHaveValue("09:00");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	expect(core.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
	await page
		.getByRole("button", { name: "New automation", exact: true })
		.last()
		.click();
	await page.getByLabel("Time (UTC)").fill("15:25");
	await page
		.getByRole("button", { name: "Create automation", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeHidden();
	await expect(
		page.getByRole("button", { name: /Daily Brief \(scheduled\)/ }).first()
	).toBeVisible();
	const expected: CreateJobBody = {
		enabled: true,
		name: "Daily Brief (scheduled)",
		quick_routine: true,
		require_approval: false,
		schedule: { kind: "cron", expr: "25 15 * * *" },
		target: {
			type: "agent",
			agent_id: "agent-daily",
			prompt: "Run",
			conversation_id: null,
		},
	};
	expect(
		core.requests.filter((r) => r.method === "POST").map((r) => r.body)
	).toEqual([expected]);
	await page.reload();
	await expect(
		page.getByRole("button", { name: /Daily Brief \(scheduled\)/ }).first()
	).toBeVisible();
	expect(core.jobs).toHaveLength(1);
	expect(core.reads.at(-1)).toEqual(core.jobs);
	expect(core.jobs[0]).toMatchObject({
		enabled: expected.enabled,
		name: expected.name,
		require_approval: expected.require_approval,
		schedule: expected.schedule,
		target: { type: "agent", agent_id: "agent-daily", prompt: "Run" },
	});
	expect(core.jobs[0]).not.toHaveProperty("quick_routine");
	expect(core.jobs[0]?.target).not.toHaveProperty("conversation_id");
	assertTransport(core.requests);
	await screenshot(page, "calendar-recovery-created-reloaded.png");
});
