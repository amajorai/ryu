import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 60_000 });

const PAGE_URL = "/agent-routines-interactions.html";
const STORAGE_KEY = "ryu:e2e:agent-routines-interactions";

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
}

async function setFixtureControl(
	page: Page,
	control: "failNextCreate" | "failNextList" | "failNextUpdate" | "holdNextRun",
	value: boolean
) {
	await page.evaluate(
		({ control, value }) => {
			const fixture =
				/* SAFETY: agent-routines-interactions.tsx installs __agentRoutinesInteractionsFixture before this proof page is evaluated. */ (
					window as Window & {
						__agentRoutinesInteractionsFixture?: {
							failNextCreate: boolean;
							failNextList: boolean;
							failNextUpdate: boolean;
							holdNextRun: boolean;
						};
					}
				).__agentRoutinesInteractionsFixture;
			if (!fixture) {
				throw new Error("Agent routines fixture was not installed.");
			}
			fixture[control] = value;
		},
		{ control, value }
	);
}

async function openPage(page: Page, search = "") {
	await page.setViewportSize({ width: 1440, height: 1200 });
	await page.goto(`${PAGE_URL}${search}`);
	await expect(page.getByTestId("agent-routines-overview")).toBeVisible();
}

async function requestsFor(page: Page, method: string, path: string) {
	return page.evaluate(
		({ method, path }) => {
			const fixture =
				/* SAFETY: agent-routines-interactions.tsx installs __agentRoutinesInteractionsFixture before this proof page is evaluated. */ (
					window as Window & {
						__agentRoutinesInteractionsFixture?: {
							requests: RecordedRequest[];
						};
					}
				).__agentRoutinesInteractionsFixture;
			return (
				fixture?.requests.filter(
					(request) => request.method === method && request.path === path
				) ?? []
			);
		},
		{ method, path }
	);
}

async function captureProductScreenshot(page: Page, filename: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: test.info().outputPath(`${filename}.png`),
	});
}

function routineRow(page: Page, name: string) {
	return page.getByTestId("agent-routine-row").filter({ hasText: name });
}

test("creates a paused cron routine in a persistent chat and reloads saved state", async ({
	page,
}) => {
	await openPage(page, "?empty=1");
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(0);
	await page.getByRole("button", { name: "Add first routine" }).click();

	const dialog = page.getByRole("dialog", { name: "Add routine" });
	await dialog.getByLabel("Routine name").fill("  Morning research brief  ");
	await dialog.getByLabel("Frequency").selectOption("cron");
	await dialog.getByLabel("Cron").fill("0 9 * * 1-5");
	await dialog.getByLabel("Time zone").fill("America/Los_Angeles");
	await dialog
		.getByLabel("Instructions")
		.fill("  Review the latest project activity.  ");
	await dialog.getByLabel("Transcript destination").selectOption("existing");
	await dialog
		.getByLabel("Persistent chat")
		.selectOption("chat-command-center");
	await dialog.getByRole("switch").nth(0).click();
	await dialog.getByRole("switch").nth(1).click();
	await expect(dialog.getByRole("switch").nth(0)).not.toBeChecked();
	await expect(dialog.getByRole("switch").nth(1)).toBeChecked();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-cron-editor"
	);

	await dialog.getByRole("button", { name: "Add routine" }).click();
	const createRequests = await requestsFor(page, "POST", "/heartbeat/jobs");
	expect(createRequests).toHaveLength(1);
	expect(createRequests[0]?.body).toEqual({
		enabled: false,
		name: "Morning research brief",
		require_approval: true,
		schedule: {
			expr: "0 9 * * 1-5",
			kind: "cron",
			tz: "America/Los_Angeles",
		},
		target: {
			agent_id: "agent-routines",
			conversation_id: "chat-command-center",
			prompt: "Review the latest project activity.",
			type: "agent",
		},
	});
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(1);
	await expect(routineRow(page, "Morning research brief")).toContainText(
		"Persistent chat"
	);
	await expect(routineRow(page, "Morning research brief")).toContainText(
		"Paused"
	);

	await page.reload();
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(1);
	await expect(routineRow(page, "Morning research brief")).toContainText(
		"cron: 0 9 * * 1-5 · Persistent chat"
	);
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-cron-persisted"
	);
});

test("creates an interval routine with a new chat and retries a rejected save", async ({
	page,
}) => {
	await openPage(page);
	await page.getByRole("button", { name: "Add routine", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Add routine" });
	await dialog.getByLabel("Routine name").fill("Every two hours");
	await dialog.getByLabel("Interval").fill("  2h  ");
	await dialog
		.getByLabel("Instructions")
		.fill("  Check the release board for new decisions.  ");
	await expect(
		dialog.getByText("Each firing gets a clean durable transcript")
	).toBeVisible();
	await setFixtureControl(page, "failNextCreate", true);

	await dialog.getByRole("button", { name: "Add routine" }).click();
	await expect(
		dialog.getByText("Local scheduler rejected this schedule.")
	).toBeVisible();
	await expect(dialog.getByLabel("Routine name")).toHaveValue(
		"Every two hours"
	);
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-save-error"
	);

	await dialog.getByRole("button", { name: "Add routine" }).click();
	const createRequests = await requestsFor(page, "POST", "/heartbeat/jobs");
	const expectedBody = {
		enabled: true,
		name: "Every two hours",
		require_approval: false,
		schedule: { interval: "2h", kind: "every" },
		target: {
			agent_id: "agent-routines",
			conversation_id: null,
			prompt: "Check the release board for new decisions.",
			type: "agent",
		},
	};
	expect(createRequests).toHaveLength(2);
	expect(createRequests[0]?.body).toEqual(expectedBody);
	expect(createRequests[1]?.body).toEqual(expectedBody);
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(4);
	await expect(routineRow(page, "Every two hours")).toContainText(
		"Every 2h · New chat each run"
	);
	await page.reload();
	await expect(routineRow(page, "Every two hours")).toBeVisible();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-interval-persisted"
	);
});

test("validates required fields and cancels without creating a routine", async ({
	page,
}) => {
	await openPage(page, "?empty=1");
	await page.getByRole("button", { name: "Add first routine" }).click();
	let dialog = page.getByRole("dialog", { name: "Add routine" });
	await dialog.getByRole("button", { name: "Add routine" }).click();
	await expect(dialog.getByText("Give this routine a name.")).toBeVisible();
	await dialog.getByLabel("Routine name").fill("Needs required fields");
	await dialog.getByLabel("Interval").fill(" ");
	await dialog.getByRole("button", { name: "Add routine" }).click();
	await expect(
		dialog.getByText("Enter a cron expression or interval.")
	).toBeVisible();
	await dialog.getByLabel("Interval").fill("1h");
	await dialog
		.getByLabel("Instructions")
		.fill("Review the latest project activity.");
	await dialog.getByLabel("Transcript destination").selectOption("existing");
	await expect(dialog.getByLabel("Persistent chat")).toHaveValue("");
	await dialog.getByRole("button", { name: "Add routine" }).click();
	await expect(dialog.getByText("Select a persistent chat.")).toBeVisible();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-validation"
	);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await requestsFor(page, "POST", "/heartbeat/jobs")).toHaveLength(0);

	await page.getByRole("button", { name: "Add first routine" }).click();
	dialog = page.getByRole("dialog", { name: "Add routine" });
	await dialog.getByLabel("Routine name").fill("Dismissed without saving");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await requestsFor(page, "POST", "/heartbeat/jobs")).toHaveLength(0);
});

test("edits schedule, chat, pause and approval settings while cancel keeps stored values", async ({
	page,
}) => {
	await openPage(page);
	const releaseRow = routineRow(page, "Release watch");
	await releaseRow.getByRole("button", { name: "Edit Release watch" }).click();
	let dialog = page.getByRole("dialog", { name: "Edit routine" });
	await dialog.getByLabel("Routine name").fill("Discarded via Escape");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(releaseRow).toContainText("Release watch");

	await releaseRow.getByRole("button", { name: "Edit Release watch" }).click();
	dialog = page.getByRole("dialog", { name: "Edit routine" });
	await dialog.getByLabel("Routine name").fill("Discarded via Cancel");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(releaseRow).toContainText("Release watch");
	expect(
		await requestsFor(page, "PUT", "/heartbeat/jobs/routine-release-watch")
	).toHaveLength(0);

	await releaseRow.getByRole("button", { name: "Edit Release watch" }).click();
	dialog = page.getByRole("dialog", { name: "Edit routine" });
	await dialog.getByLabel("Routine name").fill("Release watch revised");
	await dialog.getByLabel("Frequency").selectOption("cron");
	await dialog.getByLabel("Cron").fill("15 10 * * 1-5");
	await dialog.getByLabel("Time zone").fill("Europe/London");
	await dialog.getByLabel("Instructions").fill("Review active deployments.");
	await dialog.getByLabel("Transcript destination").selectOption("existing");
	await dialog
		.getByLabel("Persistent chat")
		.selectOption("chat-command-center");
	await dialog.getByRole("switch").nth(0).click();
	await dialog.getByRole("switch").nth(1).click();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-edit-dialog"
	);
	await setFixtureControl(page, "failNextUpdate", true);
	await dialog.getByRole("button", { name: "Save routine" }).click();
	await expect(
		dialog.getByText("Local scheduler rejected this update.")
	).toBeVisible();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-edit-save-error"
	);
	await dialog.getByRole("button", { name: "Save routine" }).click();

	const updateRequests = await requestsFor(
		page,
		"PUT",
		"/heartbeat/jobs/routine-release-watch"
	);
	expect(updateRequests).toHaveLength(2);
	const expectedBody = {
		enabled: false,
		name: "Release watch revised",
		require_approval: false,
		schedule: {
			expr: "15 10 * * 1-5",
			kind: "cron",
			tz: "Europe/London",
		},
		target: {
			agent_id: "agent-routines",
			conversation_id: "chat-command-center",
			prompt: "Review active deployments.",
			type: "agent",
		},
	};
	expect(updateRequests[0]?.body).toEqual(expectedBody);
	expect(updateRequests[1]?.body).toEqual(expectedBody);
	await expect(routineRow(page, "Release watch revised")).toContainText(
		"Paused"
	);
	await expect(routineRow(page, "Release watch revised")).toContainText(
		"cron: 15 10 * * 1-5 · Persistent chat"
	);
	await page.reload();
	await expect(routineRow(page, "Release watch revised")).toBeVisible();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-edit-persisted"
	);
});

test("refresh retries failed loads and run-now reflects its local completion", async ({
	page,
}) => {
	await openPage(page);
	await page.evaluate(() => {
		const fixture =
			/* SAFETY: agent-routines-interactions.tsx installs __agentRoutinesInteractionsFixture before this proof page is evaluated. */ (
				window as Window & {
					__agentRoutinesInteractionsFixture?: {
						renameOnNextList: { id: string; name: string } | null;
					};
				}
			).__agentRoutinesInteractionsFixture;
		if (!fixture) {
			throw new Error("Agent routines fixture was not installed.");
		}
		fixture.renameOnNextList = {
			id: "routine-morning-brief",
			name: "Morning brief refreshed",
		};
	});
	await page.getByRole("button", { exact: true, name: "Refresh" }).click();
	await expect(routineRow(page, "Morning brief refreshed")).toBeVisible();
	expect(await requestsFor(page, "GET", "/heartbeat/jobs")).toHaveLength(2);

	await setFixtureControl(page, "failNextList", true);
	await page.getByRole("button", { exact: true, name: "Refresh" }).click();
	await expect(
		page.getByText("We couldn't load your schedules. Please try again.")
	).toBeVisible();
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-refresh-error"
	);
	await page.getByRole("button", { exact: true, name: "Refresh" }).click();
	await expect(
		page.getByText("We couldn't load your schedules. Please try again.")
	).toHaveCount(0);

	await setFixtureControl(page, "holdNextRun", true);
	const runButton = page.getByRole("button", {
		name: "Run Morning brief refreshed now",
	});
	await runButton.click();
	await expect(runButton).toBeDisabled();
	expect(
		await requestsFor(page, "POST", "/heartbeat/jobs/routine-morning-brief/run")
	).toHaveLength(1);
	await page.evaluate(() => {
		const fixture =
			/* SAFETY: agent-routines-interactions.tsx installs __agentRoutinesInteractionsFixture before this proof page is evaluated. */ (
				window as Window & {
					__agentRoutinesInteractionsFixture?: {
						releaseHeldRun: (() => void) | null;
					};
				}
			).__agentRoutinesInteractionsFixture;
		fixture?.releaseHeldRun?.();
	});
	await expect(runButton).toBeEnabled();
	await expect(routineRow(page, "Morning brief refreshed")).toContainText(
		"Operational"
	);
	await expect(routineRow(page, "Morning brief refreshed")).toContainText(
		/Last run .* ago/
	);
	await page.reload();
	await expect(routineRow(page, "Morning brief refreshed")).toContainText(
		"Operational"
	);
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-run-complete"
	);
});

test("delete confirmation can be dismissed or persisted after explicit confirmation", async ({
	page,
}) => {
	await openPage(page);
	await page
		.getByRole("button", { name: "Delete Weekly planning review" })
		.click();
	const dialog = page.getByRole("alertdialog", {
		name: "Delete this routine?",
	});
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(
		"Existing chat transcripts remain available"
	);
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-delete-confirmation"
	);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(routineRow(page, "Weekly planning review")).toBeVisible();
	expect(
		await requestsFor(page, "DELETE", "/heartbeat/jobs/routine-weekly-review")
	).toHaveLength(0);

	await page
		.getByRole("button", { name: "Delete Weekly planning review" })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Delete routine" })
		.click();
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(2);
	expect(
		await requestsFor(page, "DELETE", "/heartbeat/jobs/routine-weekly-review")
	).toHaveLength(1);
	await page.reload();
	await expect(page.getByTestId("agent-routine-row")).toHaveCount(2);
	await expect(routineRow(page, "Weekly planning review")).toHaveCount(0);
	await captureProductScreenshot(
		page,
		"agent-routines-interactions-delete-persisted"
	);
});
