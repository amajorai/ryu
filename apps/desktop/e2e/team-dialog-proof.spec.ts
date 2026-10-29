import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface TeamRequestEvidence {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface TeamProofSnapshot {
	nextId: number;
	requests: TeamRequestEvidence[];
	teams: Array<{
		coordination: string;
		description: string | null;
		id: string;
		lead_agent_id: string | null;
		members: string[];
		name: string;
	}>;
}

interface TeamDialogProofState {
	failNextWrite: (path: string) => void;
	holdNextWrite: (path: string) => void;
	releaseHeldWrite: (failed: boolean) => void;
	snapshot: () => TeamProofSnapshot;
}

interface TeamDialogProofWindow extends Window {
	__teamDialogProof: TeamDialogProofState;
}

const PROOF_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

function screenshotPath(name: string): string {
	return path.join(PROOF_DIRECTORY, name);
}

async function readProof(page: Page): Promise<TeamProofSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: team-dialog-proof.tsx installs __teamDialogProof before this proof page is evaluated. */ (
			window as TeamDialogProofWindow
		).__teamDialogProof.snapshot()
	);
}

async function openHarness(page: Page, query = ""): Promise<void> {
	await page.goto(`/team-dialog-proof.html${query}`);
	await expect(page.locator('body[data-harness-ready="1"]')).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Agent groups" })
	).toBeVisible();
}

async function openDialog(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Open group dialog" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
}

async function chooseOption(
	page: Page,
	label: string,
	option: string
): Promise<void> {
	await page.getByLabel(label).click();
	const optionRow = page.getByRole("option", { name: option, exact: true });
	await optionRow.click();
	await expect(optionRow).toHaveCount(0);
}

test.describe.configure({ timeout: 60_000 });

test("create trims fields, preserves member order, selects coordination, and reads back persisted group", async ({
	page,
}) => {
	await openHarness(page);
	await openDialog(page);
	const dialog = page.getByRole("dialog");
	const create = dialog.getByRole("button", { name: "Create", exact: true });
	await expect(create).toBeDisabled();
	await dialog.getByLabel("Name").fill("   ");
	await expect(create).toBeDisabled();
	await dialog.getByLabel("Name").fill("  Launch Team  ");

	await dialog.getByRole("button", { name: /Planner$/ }).click();
	await dialog.getByRole("button", { name: /Critic$/ }).click();
	await expect(
		dialog.getByRole("button", { name: "Remove Planner", exact: true })
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Remove Planner", exact: true })
		.click();
	await dialog.getByRole("button", { name: /Runner$/ }).click();
	await expect(
		dialog.getByRole("button", { name: "Remove Planner", exact: true })
	).toHaveCount(0);
	await chooseOption(page, "How members respond", "Round-robin");
	await expect(
		page.getByText("Members answer in order", { exact: false })
	).toBeVisible();
	await expect(dialog.getByLabel("Lead agent")).toHaveCount(0);

	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-team-dialog-create-draft.png"),
	});
	await create.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const record = page.getByTestId("team-record-team-created-1");
	await expect(record).toContainText("Launch Team");
	await expect(record).toContainText("No description");
	await expect(record).toContainText(
		"round-robin · critic → runner · lead none"
	);

	const proof = await readProof(page);
	expect(
		proof.requests
			.filter((request) => request.method === "POST")
			.map(({ authorization, body, path, status }) => ({
				authorization,
				body,
				path,
				status,
			}))
	).toEqual([
		{
			authorization: "Bearer team-dialog-proof-token",
			body: {
				coordination: "round-robin",
				description: null,
				lead_agent_id: null,
				members: ["critic", "runner"],
				name: "Launch Team",
			},
			path: "/api/teams",
			status: 201,
		},
	]);
	expect(proof.teams).toContainEqual({
		coordination: "round-robin",
		created_at: "2026-04-05T06:07:08.000Z",
		description: null,
		id: "team-created-1",
		lead_agent_id: null,
		members: ["critic", "runner"],
		name: "Launch Team",
		updated_at: "2026-04-05T06:07:08.000Z",
	});
	await page.reload();
	await expect(page.getByTestId("team-record-team-created-1")).toContainText(
		"round-robin · critic → runner · lead none"
	);
});

test("edit changes members, router lead and description with an exact patch and readback", async ({
	page,
}) => {
	await openHarness(page, "?edit=1");
	await expect(page.getByTestId("team-record-team-existing")).toContainText(
		"Existing group"
	);
	await openDialog(page);
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Edit group" })
	).toBeVisible();
	await expect(dialog.getByLabel("Name")).toHaveValue("Existing group");
	await expect(dialog.getByLabel("Description (optional)")).toHaveValue(
		"Original purpose"
	);
	await expect(
		dialog.getByRole("button", { name: "Remove Planner", exact: true })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Remove Critic", exact: true })
	).toBeVisible();

	await dialog
		.getByRole("button", { name: "Remove Critic", exact: true })
		.click();
	await dialog.getByRole("button", { name: /Runner$/ }).click();
	await chooseOption(page, "How members respond", "Smart router");
	await expect(dialog.getByLabel("Router agent")).toBeVisible();
	await chooseOption(page, "Router agent", "Runner");
	await dialog.getByLabel("Name").fill("  Incident Router  ");
	await dialog
		.getByLabel("Description (optional)")
		.fill("  Route each report to the best member.  ");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);

	const record = page.getByTestId("team-record-team-existing");
	await expect(record).toContainText("Incident Router");
	await expect(record).toContainText("Route each report to the best member.");
	await expect(record).toContainText("router · planner → runner · lead runner");
	const proof = await readProof(page);
	expect(
		proof.requests
			.filter((request) => request.method === "PATCH")
			.map(({ authorization, body, path, status }) => ({
				authorization,
				body,
				path,
				status,
			}))
	).toEqual([
		{
			authorization: "Bearer team-dialog-proof-token",
			body: {
				coordination: "router",
				description: "Route each report to the best member.",
				lead_agent_id: "runner",
				members: ["planner", "runner"],
				name: "Incident Router",
			},
			path: "/api/teams/team-existing",
			status: 200,
		},
	]);
	expect(proof.teams).toContainEqual({
		coordination: "router",
		created_at: "2026-01-02T03:04:05.000Z",
		description: "Route each report to the best member.",
		id: "team-existing",
		lead_agent_id: "runner",
		members: ["planner", "runner"],
		name: "Incident Router",
		updated_at: "2026-04-05T06:07:08.000Z",
	});
	await page.reload();
	await expect(page.getByTestId("team-record-team-existing")).toContainText(
		"router · planner → runner · lead runner"
	);
	await openDialog(page);
	const reopened = page.getByRole("dialog");
	await expect(reopened.getByLabel("Name")).toHaveValue("Incident Router");
	await expect(reopened.getByLabel("Router agent")).toContainText("Runner");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-team-dialog-edited-router-readback.png"),
	});
});

test("pending create locks Submit, failure retains the draft, and retry reads back the saved group", async ({
	page,
}) => {
	await openHarness(page);
	await openDialog(page);
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Retry Group");
	await dialog
		.getByLabel("Description (optional)")
		.fill("Keep this exact draft on retry.");
	await dialog.getByRole("button", { name: /Planner$/ }).click();
	await dialog.getByRole("button", { name: /Critic$/ }).click();
	await chooseOption(page, "How members respond", "Debate + synthesis");
	await chooseOption(page, "Lead agent", "Critic");
	const expectedBody = {
		coordination: "debate-synthesis",
		description: "Keep this exact draft on retry.",
		lead_agent_id: "critic",
		members: ["planner", "critic"],
		name: "Retry Group",
	};
	await page.evaluate(() =>
		/* SAFETY: team-dialog-proof.tsx installs __teamDialogProof before this proof page is evaluated. */ (
			window as TeamDialogProofWindow
		).__teamDialogProof.holdNextWrite("/api/teams")
	);
	const submit = dialog.getByRole("button", { name: /Create/ });
	await submit.click();
	await expect(submit).toBeDisabled();
	let proof = await readProof(page);
	expect(proof.requests.at(-1)).toMatchObject({
		body: expectedBody,
		method: "POST",
		path: "/api/teams",
		status: null,
	});
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-team-dialog-create-pending.png"),
	});
	await page.evaluate(() =>
		/* SAFETY: team-dialog-proof.tsx installs __teamDialogProof before this proof page is evaluated. */ (
			window as TeamDialogProofWindow
		).__teamDialogProof.releaseHeldWrite(true)
	);
	await expect(
		dialog.getByText("/api/teams failed: 503", { exact: true })
	).toBeVisible();
	await expect(dialog.getByLabel("Name")).toHaveValue("Retry Group");
	await expect(dialog.getByLabel("Description (optional)")).toHaveValue(
		"Keep this exact draft on retry."
	);
	await expect(
		dialog.getByRole("button", { name: "Remove Planner", exact: true })
	).toBeVisible();
	proof = await readProof(page);
	expect(proof.teams).toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-team-dialog-create-error-draft-retained.png"),
	});

	await dialog.getByRole("button", { name: /Create/ }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByTestId("team-record-team-created-1")).toContainText(
		"Retry Group"
	);
	proof = await readProof(page);
	expect(
		proof.requests
			.filter((request) => request.method === "POST")
			.map(({ body, status }) => ({ body, status }))
	).toEqual([
		{ body: expectedBody, status: 503 },
		{ body: expectedBody, status: 201 },
	]);
	expect(proof.teams).toContainEqual({
		coordination: "debate-synthesis",
		created_at: "2026-04-05T06:07:08.000Z",
		description: "Keep this exact draft on retry.",
		id: "team-created-1",
		lead_agent_id: "critic",
		members: ["planner", "critic"],
		name: "Retry Group",
		updated_at: "2026-04-05T06:07:08.000Z",
	});
});

test("Cancel, close button, and Escape discard unsaved form state without writes", async ({
	page,
}) => {
	await openHarness(page);
	await openDialog(page);
	let dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Unsaved group");
	await dialog.getByLabel("Description (optional)").fill("Discard me");
	await dialog.getByRole("button", { name: /Planner$/ }).click();
	await chooseOption(page, "How members respond", "Debate + synthesis");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	let proof = await readProof(page);
	expect(proof.requests.filter((request) => request.method === "POST")).toEqual(
		[]
	);

	await openDialog(page);
	dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("Name")).toHaveValue("");
	await expect(dialog.getByLabel("Description (optional)")).toHaveValue("");
	await expect(dialog.getByLabel("How members respond")).toContainText(
		"Broadcast"
	);
	await expect(
		dialog.getByRole("button", { name: "Remove Planner" })
	).toHaveCount(0);
	await dialog.getByLabel("Name").fill("Also unsaved");
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await openDialog(page);
	dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("Name")).toHaveValue("");
	await dialog.getByLabel("Name").fill("Escape draft");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	proof = await readProof(page);
	expect(proof.requests.filter((request) => request.method === "POST")).toEqual(
		[]
	);
	await page.getByRole("button", { name: "Open group dialog" }).click();
	dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("Name")).toHaveValue("");
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("desktop-team-dialog-cancel-reset.png"),
	});
});
