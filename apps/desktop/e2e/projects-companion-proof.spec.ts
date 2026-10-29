import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function resetFixture(
	page: Page,
	options: {
		seed?: string;
		createFailures?: number;
		failPatch?: number;
		failRun?: number;
		failWorker?: number;
	} = {}
) {
	const response = await page.request.post("/__fixture/reset", {
		data: options,
	});
	expect(response.ok()).toBeTruthy();
}

async function fixtureState(page: Page) {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBeTruthy();
	return z
		.object({
			calls: z.array(
				z.object({
					body: z.json().optional(),
					method: z.string(),
					path: z.string(),
				})
			),
			context: z.record(
				z.string(),
				z.array(z.object({ content: z.string(), title: z.string() }))
			),
			docs: z.array(
				z.object({ id: z.string(), source: z.string(), title: z.string() })
			),
			projects: z.array(
				z.object({
					client: z.string(),
					cwd: z.string().nullable(),
					description: z.string(),
					dueDate: z.string(),
					executionMode: z.string(),
					id: z.string(),
					name: z.string(),
					owner: z.string(),
					status: z.string(),
					tasks: z.array(z.object({ status: z.string(), title: z.string() })),
				})
			),
			spaceCalls: z.array(z.object({ method: z.string(), payload: z.json() })),
			subscriptions: z.record(
				z.string(),
				z.array(
					z.object({
						kind: z.string(),
						name: z.string(),
						schedule: z.string().nullable(),
					})
				)
			),
			workers: z.record(
				z.string(),
				z.array(z.object({ task: z.string(), title: z.string() }))
			),
		})
		.parse(await response.json());
}

async function openProjects(page: Page) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Direct the work, not the agents." })
	).toBeVisible();
	return pageErrors;
}

async function capture(page: Page, name: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, name),
	});
}

test("create validates and persists a project through the Spaces mirror, then filters and reopens it", async ({
	page,
}) => {
	await resetFixture(page);
	const pageErrors = await openProjects(page);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
	await page.getByRole("button", { name: "Create project" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Give the project a name."
	);
	await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();

	await page.getByLabel("Project name").fill("  Coverage roadmap  ");
	await page.getByLabel("Client or team").fill("Northstar Labs");
	await page.getByLabel("Owner", { exact: true }).fill("Avery");
	await page.getByLabel("Due date").fill("2026-10-20");
	await page.getByLabel("Execution target").selectOption("local");
	await page.getByLabel("Working folder").fill("/workspace/ryu");
	await page.getByLabel("Description").fill("Deliver the quarter plan.");
	await page.getByRole("button", { name: "Create project" }).click();
	await expect(page.getByRole("dialog", { name: "New project" })).toBeHidden();
	await expect(
		page.getByRole("heading", { name: "Coverage roadmap" })
	).toBeVisible();
	await expect(page.locator(".projects-heading-actions")).toContainText(
		"Local"
	);

	const createdState = await fixtureState(page);
	const created = createdState.projects.find(
		(project) => project.name === "Coverage roadmap"
	);
	expect(created).toMatchObject({
		client: "Northstar Labs",
		cwd: "/workspace/ryu",
		description: "Deliver the quarter plan.",
		dueDate: "2026-10-20",
		executionMode: "local",
		owner: "Avery",
		status: "planned",
		tasks: [],
	});
	const createCall = createdState.calls.find(
		(call) => call.method === "POST" && call.path === "/projects"
	);
	expect(createCall?.body).toEqual({
		client: "Northstar Labs",
		cwd: "/workspace/ryu",
		description: "Deliver the quarter plan.",
		dueDate: "2026-10-20",
		executionMode: "local",
		name: "Coverage roadmap",
		owner: "Avery",
	});
	await expect.poll(async () => (await fixtureState(page)).docs.length).toBe(1);
	const mirrorState = await fixtureState(page);
	expect(mirrorState.docs[0]?.title).toBe("Project · Coverage roadmap");
	expect(JSON.parse(mirrorState.docs[0]?.source ?? "{}")).toMatchObject({
		project: { id: created?.id, name: "Coverage roadmap" },
		context: [],
	});
	await capture(page, "projects-create-persisted-spaces.png");

	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Coverage roadmap" })
	).toBeVisible();
	await page.getByLabel("Project filter").selectOption("planned");
	await expect(
		page.getByRole("option", { name: /Coverage roadmap/ })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: /Launch workspace/ })
	).toHaveCount(0);
	await page.getByLabel("Project filter").selectOption("active");
	await expect(
		page.getByRole("option", { name: /Launch workspace/ })
	).toBeVisible();
	await page.getByRole("option", { name: /Launch workspace/ }).click();
	await expect(
		page.getByRole("heading", { name: "Launch workspace" })
	).toBeVisible();
	await page.getByLabel("Project filter").selectOption("blocked");
	await expect(
		page.getByRole("option", { name: /Blocked workspace/ })
	).toBeVisible();
	await page.getByLabel("Project filter").selectOption("done");
	await expect(
		page.getByRole("option", { name: /Done workspace/ })
	).toBeVisible();
	await page.getByLabel("Project filter").selectOption("all");
	await expect(
		page.getByRole("option", { name: /Coverage roadmap/ })
	).toBeVisible();
	expect(pageErrors).toEqual([]);
});

test("project edits roll back on a rejected write, retry successfully, and task transitions persist", async ({
	page,
}) => {
	await resetFixture(page, { failPatch: 1 });
	const pageErrors = await openProjects(page);
	await page.getByLabel("Project owner").fill("Jordan");
	await expect(page.getByRole("alert")).toContainText(
		"Fixture rejected project update."
	);
	await expect(page.getByLabel("Project owner")).toHaveValue("Mira");
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.owner)
		.toBe("Mira");
	await page.getByRole("button", { name: "Dismiss" }).click();
	await page.getByLabel("Project owner").fill("Jordan");
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.owner)
		.toBe("Jordan");
	await page.getByLabel("Project status").selectOption("blocked");
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.status)
		.toBe("blocked");
	await page.getByLabel("Project execution mode").selectOption("cloud");
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.executionMode)
		.toBe("cloud");
	await expect(page.locator(".projects-heading-actions")).toContainText(
		"Cloud"
	);

	await page.getByLabel("New task").fill("Prepare rollout notes");
	await page.getByRole("button", { name: "Add task", exact: true }).click();
	await expect(
		page.getByRole("listitem").filter({ hasText: "Prepare rollout notes" })
	).toBeVisible();
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.tasks.length)
		.toBe(2);
	const taskStatusButton = page.getByRole("button", {
		name: "Move Prepare rollout notes to next status",
	});
	await taskStatusButton.click();
	await expect(
		page.locator(".projects-task").filter({ hasText: "Prepare rollout notes" })
	).toContainText("In progress");
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.tasks[1]?.status)
		.toBe("doing");
	await page
		.getByRole("button", { name: "Move Prepare rollout notes to next status" })
		.click();
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.tasks[1]?.status)
		.toBe("done");
	await page
		.getByRole("button", { name: "Move Prepare rollout notes to next status" })
		.click();
	await expect
		.poll(async () => (await fixtureState(page)).projects[0]?.tasks[1]?.status)
		.toBe("todo");
	await expect(page.locator(".projects-summary")).toContainText("2 open tasks");
	await page.reload();
	await expect(page.getByLabel("Project owner")).toHaveValue("Jordan");
	await expect(page.getByLabel("Project status")).toHaveValue("blocked");
	await expect(page.getByLabel("Project execution mode")).toHaveValue("cloud");
	await expect(page.getByRole("listitem")).toContainText(
		"Prepare rollout notes"
	);
	await capture(page, "projects-edit-task-status-reload.png");
	const state = await fixtureState(page);
	const patches = state.calls.filter((call) => call.method === "PATCH");
	expect(patches.map((call) => call.path)).toContain(
		"/projects/project-launch"
	);
	expect(
		patches.some((call) =>
			JSON.stringify(call.body).includes('"status":"doing"')
		)
	).toBe(true);
	expect(
		patches.some((call) =>
			JSON.stringify(call.body).includes('"status":"done"')
		)
	).toBe(true);
	expect(pageErrors).toEqual([]);
});

test("context, coordinator retry, workers, and every subscription kind reach node APIs and survive reopening", async ({
	page,
}) => {
	await resetFixture(page, { failRun: 1, failWorker: 1 });
	const pageErrors = await openProjects(page);

	await page.getByLabel("Context title").fill("Release rule");
	await page
		.getByLabel("Context content")
		.fill("Every migration needs rollback notes.");
	await page.getByRole("button", { name: "Save context" }).click();
	await expect(page.locator(".projects-context-list")).toContainText(
		"Release rule"
	);
	await expect(page.locator(".projects-context-list")).toContainText(
		"Every migration needs rollback notes."
	);
	await expect
		.poll(
			async () => (await fixtureState(page)).context["project-launch"]?.length
		)
		.toBe(1);
	await expect
		.poll(
			async () =>
				JSON.parse((await fixtureState(page)).docs[0]?.source ?? "{}").context
					?.length
		)
		.toBe(1);

	await page.getByLabel("Coordinator request").fill("Prepare a rollback plan.");
	await page.getByRole("button", { name: "Run coordinator" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture coordinator is temporarily offline."
	);
	await expect(page.getByLabel("Coordinator request")).toHaveValue(
		"Prepare a rollback plan."
	);
	await page.getByRole("button", { name: "Dismiss" }).click();
	await page.getByRole("button", { name: "Run coordinator" }).click();
	await expect(page.getByLabel("Coordinator request")).toHaveValue("");
	await expect(page.getByText("Persistent thread")).toBeVisible();

	await page.getByLabel("Worker title").fill("QA handoff");
	await page
		.getByLabel("Worker task")
		.fill("Verify migration on a clean install.");
	await page.getByRole("button", { name: "Dispatch worker" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture worker dispatch temporarily unavailable."
	);
	await expect(page.getByLabel("Worker title")).toHaveValue("QA handoff");
	await expect(page.getByLabel("Worker task")).toHaveValue(
		"Verify migration on a clean install."
	);
	await page.getByRole("button", { name: "Dismiss" }).click();
	await page.getByLabel("Worker title").fill("QA handoff");
	await page
		.getByLabel("Worker task")
		.fill("Verify migration on a clean install.");
	await page.getByRole("button", { name: "Dispatch worker" }).click();
	await expect(page.locator(".projects-worker")).toContainText("QA handoff");
	await expect
		.poll(
			async () => (await fixtureState(page)).workers["project-launch"]?.length
		)
		.toBe(1);

	await page.getByLabel("Subscription name").fill("Morning pulse");
	await page.getByLabel("Subscription interval").fill("2h");
	await page.getByRole("button", { name: "Arm subscription" }).click();
	await page.getByLabel("Subscription kind").selectOption("slack");
	await expect(page.getByLabel("Subscription interval")).toHaveCount(0);
	await page.getByLabel("Subscription name").fill("Slack delivery");
	await page.getByRole("button", { name: "Arm subscription" }).click();
	await page.getByLabel("Subscription kind").selectOption("pull_request");
	await expect(page.getByLabel("Subscription kind")).toHaveValue(
		"pull_request"
	);
	await page.getByLabel("Subscription name").fill("Review webhook");
	await expect(page.getByLabel("Subscription name")).toHaveValue(
		"Review webhook"
	);
	await page.getByRole("button", { name: "Arm subscription" }).click();
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).calls.filter(
					(call) =>
						call.method === "POST" && call.path.endsWith("/subscriptions")
				).length
		)
		.toBe(3);
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).subscriptions["project-launch"]?.length
		)
		.toBe(3);
	const state = await fixtureState(page);
	expect(state.subscriptions["project-launch"]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "schedule",
				name: "Morning pulse",
				schedule: "2h",
			}),
			expect.objectContaining({ kind: "slack", name: "Slack delivery" }),
			expect.objectContaining({ kind: "pull_request", name: "Review webhook" }),
		])
	);
	expect(state.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
		prompt: "Prepare a rollback plan.",
	});
	expect(
		state.calls.find((call) => call.path.endsWith("/workers"))?.body
	).toEqual({
		title: "QA handoff",
		task: "Verify migration on a clean install.",
	});
	await page.reload();
	await expect(page.locator(".projects-context-list")).toContainText(
		"Release rule"
	);
	await expect(page.locator(".projects-worker")).toContainText("QA handoff");
	await expect(page.locator(".projects-worker")).toContainText("Morning pulse");
	await capture(page, "projects-context-coordinator-workers-subscriptions.png");
	expect(pageErrors).toEqual([]);
});

test("failed project creation remains editable and retries with the same values", async ({
	page,
}) => {
	await resetFixture(page, { createFailures: 1 });
	await openProjects(page);
	await page.getByRole("button", { name: "New project" }).click();
	await page.getByLabel("Project name").fill("Retryable project");
	await page.getByLabel("Client or team").fill("Core team");
	await page.getByLabel("Owner", { exact: true }).fill("Kai");
	await page.getByRole("button", { name: "Create project" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture project create temporarily unavailable."
	);
	await expect(page.getByLabel("Project name")).toHaveValue(
		"Retryable project"
	);
	await page.getByRole("button", { name: "Create project" }).click();
	await expect(
		page.getByRole("heading", { name: "Retryable project" })
	).toBeVisible();
	const state = await fixtureState(page);
	expect(
		state.calls.filter(
			(call) => call.method === "POST" && call.path === "/projects"
		)
	).toHaveLength(2);
	expect(
		state.projects.find((project) => project.name === "Retryable project")
	).toMatchObject({
		client: "Core team",
		owner: "Kai",
	});
	await capture(page, "projects-create-retry-success.png");
});
