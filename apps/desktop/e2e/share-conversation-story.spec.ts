import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { apiCallsProofSchema } from "./settings-domain-proof.contracts.ts";

const EVIDENCE_ROOT = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const HISTORY_EVIDENCE_ROOT = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/portable-git-history-20260930"
);

async function apiCalls(page: import("@playwright/test").Page) {
	const text = await page.getByTestId("share-calls").textContent();
	return apiCallsProofSchema.parse(JSON.parse(text ?? "[]"));
}

async function capture(page: import("@playwright/test").Page, name: string) {
	await mkdir(EVIDENCE_ROOT, { recursive: true });
	return page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_ROOT, name),
	});
}

test.describe.configure({ timeout: 90_000 });

test("conversation sharing exposes the live and public access controls", async ({
	page,
}) => {
	await page.goto("/share-conversation-story.html?visibility=private");
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Launch readiness and rollout plan");
	await expect(dialog).toContainText("Jia Wei Ng (you)");
	await expect(dialog).toContainText("Noor Aziz");
	await expect(dialog.getByLabel("Role for Noor Aziz")).toContainText("Viewer");
	await expect(
		dialog.getByRole("combobox", { name: "General access" })
	).toContainText("Restricted");
	await expect(dialog).toContainText("frozen copy");
	await expect(dialog.getByRole("button", { name: "Copy link" })).toHaveCount(
		0
	);
	await expect(dialog.getByRole("button", { name: "Update copy" })).toHaveCount(
		0
	);

	await dialog.getByRole("combobox", { name: "General access" }).click();
	await expect(page.getByRole("option", { name: "Restricted" })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Anyone in the organization" })
	).toBeVisible();
	await expect(page.getByRole("option", { name: "A team" })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Anyone with the link" })
	).toBeVisible();

	await page.getByRole("option", { name: "Anyone with the link" }).click();
	await expect(dialog.getByRole("button", { name: "Copy link" })).toBeEnabled();
	await expect(dialog.getByRole("button", { name: "Update copy" })).toHaveCount(
		0
	);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByTestId("share-result")).toHaveText("published");
	const calls = await apiCalls(page);
	expect(calls.filter((call) => call.method === "PUT")).toEqual([
		{
			body: {
				collaborators: [{ role: "viewer", user_id: "user-noor" }],
				team_id: null,
				visibility: "private",
			},
			method: "PUT",
			path: "/api/conversations/conversation-1/access",
		},
		{
			body: {
				messages: [
					{
						content: "Can we share this rollout plan?",
						created_at: 1_724_000_000_000,
						id: "message-1",
						role: "user",
					},
					{
						content:
							"Yes — I’ve separated the public milestones from the internal notes.",
						created_at: 1_724_000_010_000,
						id: "message-2",
						role: "assistant",
					},
				],
				title: "Launch readiness and rollout plan",
			},
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
	]);
});

test("redacted history is reviewed before Git save, push, and public share", async ({
	page,
}, testInfo) => {
	await page.goto(
		"/share-conversation-story.html?visibility=private&sensitive=1"
	);
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog.getByTestId("history-preview-summary")).toContainText(
		"1 PII · 1 secrets · 0 custom redacted"
	);
	await dialog.getByText("Review redacted transcript").click();
	const reviewed = dialog.getByTestId("history-redacted-transcript");
	await expect(reviewed).toContainText("[REDACTED:EMAIL]");
	await expect(reviewed).toContainText("[REDACTED:CREDENTIAL]");
	await expect(reviewed).not.toContainText("ava@example.com");
	await expect(reviewed).not.toContainText("hunter2");
	await expect(reviewed).toContainText("Project Cobalt");
	await dialog.getByLabel("More terms to hide").fill("Project Cobalt");
	await expect(
		dialog.getByRole("button", { name: "Save in Git" })
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Apply to preview" }).click();
	await expect(dialog.getByTestId("history-preview-summary")).toContainText(
		"1 custom redacted"
	);
	await dialog.getByText("Review redacted transcript").click();
	await expect(reviewed).toContainText("[REDACTED:CUSTOM]");
	await expect(reviewed).not.toContainText("Project Cobalt");

	await dialog.getByRole("button", { name: "Save in Git" }).click();
	await expect(page.getByTestId("share-result")).toHaveText("git-saved");
	let calls = await apiCalls(page);
	expect(calls.some((call) => call.path === "/api/git/history/sync")).toBe(
		false
	);
	expect(
		calls.find(
			(call) =>
				call.path === "/api/conversations/conversation-1/git-history" &&
				call.method === "POST"
		)?.body
	).toEqual({
		expectedCheckpointId: "d".repeat(64),
		expectedHead: "b".repeat(40),
		expectedRepoRoot: "/tmp/ryu-history-project",
		extraRedactions: ["Project Cobalt"],
	});

	await dialog.getByRole("button", { name: "Push history to origin" }).click();
	await expect(page.getByTestId("share-result")).toHaveText("history-pushed");
	const pushCall = (await apiCalls(page)).find(
		(call) => call.path === "/api/git/history/sync" && call.method === "POST"
	);
	expect(pushCall).toEqual({
		body: { action: "push", cwd: "/tmp/ryu-history-project" },
		method: "POST",
		path: "/api/git/history/sync",
	});
	await reviewed.scrollIntoViewIfNeeded();
	await mkdir(HISTORY_EVIDENCE_ROOT, { recursive: true });
	const screenshot = await page.screenshot({
		path: path.join(HISTORY_EVIDENCE_ROOT, "redacted-history-review.png"),
	});
	await testInfo.attach("redacted-history-review.png", {
		body: screenshot,
		contentType: "image/png",
	});

	await dialog.getByRole("combobox", { name: "General access" }).click();
	await page.getByRole("option", { name: "Anyone with the link" }).click();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	calls = await apiCalls(page);
	const published = calls.find(
		(call) =>
			call.path === "/api/conversation-shares/conversation/conversation-1" &&
			call.method === "PUT"
	);
	expect(published).toBeDefined();
	const payload = JSON.stringify(published?.body);
	expect(payload).toContain("[REDACTED:EMAIL]");
	expect(payload).toContain("[REDACTED:CREDENTIAL]");
	expect(payload).toContain("[REDACTED:CUSTOM]");
	expect(payload).not.toContain("ava@example.com");
	expect(payload).not.toContain("hunter2");
	expect(payload).not.toContain("Project Cobalt");
});

test("a cloned project can fetch, review, and restore Git conversation history", async ({
	page,
}, testInfo) => {
	await page.goto("/share-conversation-story.html?restore-empty=1&sensitive=1");
	const dialog = page.getByTestId("git-history-dialog");
	await expect(dialog).toContainText("No saved conversations");
	await dialog
		.getByRole("button", { name: "Fetch history from origin" })
		.click();
	await expect(dialog).toContainText("Launch readiness and rollout plan");
	await dialog
		.getByRole("button", { name: /Launch readiness and rollout plan/ })
		.click();
	const transcript = dialog.getByTestId("git-history-transcript");
	await expect(transcript).toContainText("[REDACTED:EMAIL]");
	await expect(transcript).toContainText("[REDACTED:CREDENTIAL]");
	await expect(transcript).not.toContainText("ava@example.com");
	await expect(
		dialog.getByRole("button", { name: "Restore conversation" })
	).toBeEnabled();
	await mkdir(HISTORY_EVIDENCE_ROOT, { recursive: true });
	const screenshot = await page.screenshot({
		path: path.join(HISTORY_EVIDENCE_ROOT, "git-history-restore.png"),
	});
	await testInfo.attach("git-history-restore.png", {
		body: screenshot,
		contentType: "image/png",
	});
	await dialog.getByRole("button", { name: "Restore conversation" }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByTestId("share-result")).toHaveText(
		"restored:git-restored-conversation"
	);
	const calls = await apiCalls(page);
	expect(
		calls.some(
			(call) => call.path === "/api/git/history/sync" && call.method === "POST"
		)
	).toBe(true);
	expect(
		calls.some(
			(call) =>
				call.path === "/api/git/history/import" && call.method === "POST"
		)
	).toBe(true);
});

test("viewers can inspect access without changing it", async ({ page }) => {
	await page.goto("/share-conversation-story.html?readonly=1");
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Mira Chen");
	await expect(dialog.getByLabel("Add a person")).toBeDisabled();
	await expect(dialog.getByLabel("Role for Jia Wei Ng")).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Remove Jia Wei Ng" })
	).toBeDisabled();
	await expect(
		dialog.getByRole("combobox", { name: "General access" })
	).toBeDisabled();
	await expect(
		dialog.getByRole("button", { name: "Save in Git" })
	).toBeDisabled();
	await expect(dialog).toContainText(
		"Only the owner or an organization admin can change access."
	);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	expect(
		(await apiCalls(page)).filter(
			(call) => call.method === "PUT" || call.method === "DELETE"
		)
	).toHaveLength(0);
});

test("collaborator changes use exact roles and persist after the dialog reopens", async ({
	page,
}) => {
	await page.goto("/share-conversation-story.html?visibility=private");
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog.getByText("Noor Aziz", { exact: true })).toBeVisible();
	await dialog.getByRole("combobox", { name: "Add a person" }).click();
	await page.getByRole("option", { name: /Mira Chen/ }).click();
	await expect(dialog.getByLabel("Role for Mira Chen")).toContainText("Viewer");

	await dialog.getByLabel("Role for Mira Chen").click();
	await page.getByRole("option", { name: "Participant", exact: true }).click();
	await dialog.getByRole("button", { name: "Remove Noor Aziz" }).click();
	await expect(dialog.getByText("Noor Aziz", { exact: true })).toHaveCount(0);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();

	const calls = await apiCalls(page);
	const writes = calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/conversations/conversation-1/access"
	);
	expect(writes).toEqual([
		{
			body: {
				collaborators: [{ role: "participant", user_id: "user-mira" }],
				team_id: null,
				visibility: "private",
			},
			method: "PUT",
			path: "/api/conversations/conversation-1/access",
		},
	]);

	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(dialog.getByLabel("Role for Mira Chen")).toContainText(
		"Participant"
	);
	await expect(dialog.getByText("Noor Aziz", { exact: true })).toHaveCount(0);
});

test("team access requires a team and organization access clears the team id", async ({
	page,
}, testInfo) => {
	await page.goto("/share-conversation-story.html?visibility=private");
	const dialog = page.getByTestId("share-conversation-dialog");
	const generalAccess = dialog.getByRole("combobox", {
		name: "General access",
	});
	await generalAccess.click();
	await page.getByRole("option", { name: "A team", exact: true }).click();
	const team = dialog.getByRole("combobox", { name: "Team" });
	await expect(team).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Choose a team before saving."
	);
	let calls = await apiCalls(page);
	expect(
		calls.filter(
			(call) =>
				call.method === "PUT" &&
				call.path === "/api/conversations/conversation-1/access"
		)
	).toHaveLength(0);

	await team.click();
	await page.getByRole("option", { name: "Research", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await dialog.getByRole("heading", { name: "General access" }).click();
	const teamShot = await capture(
		page,
		"desktop-share-conversation-team-access.png"
	);
	await testInfo.attach("team-access.png", {
		body: teamShot,
		contentType: "image/png",
	});
	await dialog.getByRole("button", { name: "Done" }).click();
	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(dialog.getByRole("combobox", { name: "Team" })).toContainText(
		"Research"
	);

	await generalAccess.click();
	await page
		.getByRole("option", { name: "Anyone in the organization", exact: true })
		.click();
	await expect(generalAccess).toContainText("Anyone in the organization");
	await expect(dialog.getByRole("combobox", { name: "Team" })).toHaveCount(0);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	calls = await apiCalls(page);
	const accessWrites = calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/conversations/conversation-1/access"
	);
	expect(accessWrites.map((call) => call.body)).toEqual([
		{
			collaborators: [{ role: "viewer", user_id: "user-noor" }],
			team_id: "team-research",
			visibility: "team",
		},
		{
			collaborators: [{ role: "viewer", user_id: "user-noor" }],
			team_id: null,
			visibility: "org",
		},
	]);

	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(
		dialog.getByRole("combobox", { name: "General access" })
	).toContainText("Anyone in the organization");
});

test("restricting access revokes the public copy and removes link actions", async ({
	page,
}) => {
	await page.goto("/share-conversation-story.html");
	const dialog = page.getByTestId("share-conversation-dialog");
	const generalAccess = dialog.getByRole("combobox", {
		name: "General access",
	});
	await expect(generalAccess).toContainText("Anyone with the link");
	await expect(dialog.getByRole("button", { name: "Copy link" })).toBeEnabled();
	await expect(
		dialog.getByRole("button", { name: "Update copy" })
	).toBeEnabled();

	await generalAccess.click();
	await page.getByRole("option", { name: "Restricted" }).click();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();

	const expectedAccess = {
		collaborators: [{ role: "viewer", user_id: "user-noor" }],
		team_id: null,
		visibility: "private",
	};
	expect(
		(await apiCalls(page)).filter(
			(call) => call.method === "PUT" || call.method === "DELETE"
		)
	).toEqual([
		{
			body: null,
			method: "DELETE",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
		{
			body: expectedAccess,
			method: "PUT",
			path: "/api/conversations/conversation-1/access",
		},
	]);

	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(generalAccess).toContainText("Restricted");
	await expect(dialog.getByRole("button", { name: "Copy link" })).toHaveCount(
		0
	);
	await expect(dialog.getByRole("button", { name: "Update copy" })).toHaveCount(
		0
	);
});

test("Cancel and Escape discard drafts without issuing access writes", async ({
	page,
}) => {
	await page.goto("/share-conversation-story.html?visibility=private");
	const dialog = page.getByTestId("share-conversation-dialog");
	await dialog.getByRole("combobox", { name: "Add a person" }).click();
	await page.getByRole("option", { name: /Mira Chen/ }).click();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).not.toBeVisible();
	expect(
		(await apiCalls(page)).filter(
			(call) => call.method === "PUT" || call.method === "DELETE"
		)
	).toHaveLength(0);

	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(dialog.getByLabel("Add a person")).toBeVisible();
	await expect(dialog.getByText("Mira Chen", { exact: true })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	expect(
		(await apiCalls(page)).filter(
			(call) => call.method === "PUT" || call.method === "DELETE"
		)
	).toHaveLength(0);

	await page.getByRole("button", { name: "Open sharing" }).click();
	await dialog.getByRole("combobox", { name: "Add a person" }).click();
	await page.getByRole("option", { name: /Mira Chen/ }).click();
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).not.toBeVisible();
	expect(
		(await apiCalls(page)).filter(
			(call) => call.method === "PUT" || call.method === "DELETE"
		)
	).toHaveLength(0);
	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(dialog.getByText("Mira Chen", { exact: true })).toHaveCount(0);
});

test("failed access save keeps the draft and retries the identical payload", async ({
	page,
}, testInfo) => {
	await page.goto(
		"/share-conversation-story.html?visibility=private&savefail=once"
	);
	const dialog = page.getByTestId("share-conversation-dialog");
	await dialog.getByRole("combobox", { name: "General access" }).click();
	await page.getByRole("option", { name: "A team", exact: true }).click();
	await dialog.getByRole("combobox", { name: "Team" }).click();
	await page.getByRole("option", { name: "Product", exact: true }).click();
	await dialog.getByRole("heading", { name: "General access" }).click();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"/api/conversations/conversation-1/access failed: 503"
	);
	await expect(dialog.getByRole("combobox", { name: "Team" })).toContainText(
		"Product"
	);
	const failureShot = await capture(
		page,
		"desktop-share-conversation-save-error-draft-retained.png"
	);
	await testInfo.attach("save-error-draft-retained.png", {
		body: failureShot,
		contentType: "image/png",
	});
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();

	const accessWrites = (await apiCalls(page)).filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/conversations/conversation-1/access"
	);
	expect(accessWrites).toEqual([
		{
			body: {
				collaborators: [{ role: "viewer", user_id: "user-noor" }],
				team_id: "team-product",
				visibility: "team",
			},
			method: "PUT",
			path: "/api/conversations/conversation-1/access",
		},
		{
			body: {
				collaborators: [{ role: "viewer", user_id: "user-noor" }],
				team_id: "team-product",
				visibility: "team",
			},
			method: "PUT",
			path: "/api/conversations/conversation-1/access",
		},
	]);

	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(dialog.getByRole("combobox", { name: "Team" })).toContainText(
		"Product"
	);
});

test("load failure retries the exact local read and then renders recovered access", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-story.html?visibility=private&loadfail=once"
	);
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(dialog).toContainText(
		"/api/conversations/conversation-1/access failed: 503"
	);
	await dialog.getByRole("button", { name: "Try again" }).click();
	await expect(dialog.getByText("Noor Aziz", { exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(
		0
	);
	const readCalls = (await apiCalls(page)).filter(
		(call) =>
			call.method === "GET" &&
			call.path === "/api/conversations/conversation-1/access"
	);
	expect(readCalls).toHaveLength(2);
});

test("privacy-preview failure retries and restores the redacted review", async ({
	page,
}) => {
	await page.goto(
		"/share-conversation-story.html?visibility=private&previewfail=once"
	);
	const dialog = page.getByTestId("share-conversation-dialog");
	await expect(dialog.getByRole("alert")).toHaveText(
		"/api/conversations/conversation-1/history-preview failed: 503"
	);
	const retryPreview = dialog.getByRole("button", { name: "Retry preview" });
	await expect(retryPreview).toBeEnabled();
	await retryPreview.click();
	await expect(dialog.getByTestId("history-preview-summary")).toContainText(
		"2 messages · 0 PII · 0 secrets · 0 custom redacted"
	);
	await dialog.getByText("Review redacted transcript").click();
	const reviewed = dialog.getByTestId("history-redacted-transcript");
	await expect(reviewed).toContainText("Can we share this rollout plan?");
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	const historyPreviewRequests = (await apiCalls(page)).filter(
		(call) => call.path === "/api/conversations/conversation-1/history-preview"
	);
	expect(historyPreviewRequests).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/conversations/conversation-1/history-preview",
		},
		{
			body: null,
			method: "GET",
			path: "/api/conversations/conversation-1/history-preview",
		},
	]);
});

test("public-copy update retries the exact transcript while Copy link reads the clipboard", async ({
	page,
}, testInfo) => {
	await page.goto("/share-conversation-story.html?publishfail=once");
	const origin = new URL(page.url()).origin;
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin,
	});
	const dialog = page.getByTestId("share-conversation-dialog");
	await dialog.getByRole("button", { name: "Copy link" }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("https://ryu.test/share/story-token");
	const copyCalls = await apiCalls(page);
	expect(
		copyCalls.filter(
			(call) =>
				call.method === "PUT" ||
				call.path === "/api/conversations/conversation-1"
		)
	).toHaveLength(0);

	await dialog.getByRole("button", { name: "Update copy" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"Fixture public copy update failed."
	);
	const copyFailure = await capture(
		page,
		"desktop-share-conversation-update-copy-error.png"
	);
	await testInfo.attach("update-copy-error.png", {
		body: copyFailure,
		contentType: "image/png",
	});
	await dialog.getByRole("button", { name: "Update copy" }).click();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await apiCalls(page)).filter(
					(call) =>
						call.method === "PUT" &&
						call.path === "/api/conversation-shares/conversation/conversation-1"
				).length
		)
		.toBe(2);
	await expect(
		dialog.getByRole("button", { name: "Update copy" })
	).toBeEnabled();

	const publishes = (await apiCalls(page)).filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/conversation-shares/conversation/conversation-1"
	);
	const exactBody = {
		messages: [
			{
				content: "Can we share this rollout plan?",
				created_at: 1_724_000_000_000,
				id: "message-1",
				role: "user",
			},
			{
				content:
					"Yes — I’ve separated the public milestones from the internal notes.",
				created_at: 1_724_000_010_000,
				id: "message-2",
				role: "assistant",
			},
		],
		title: "Launch readiness and rollout plan",
	};
	expect(publishes).toEqual([
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
	]);
	const publicShot = await capture(
		page,
		"desktop-share-conversation-public-copy-persisted.png"
	);
	await testInfo.attach("public-copy-persisted.png", {
		body: publicShot,
		contentType: "image/png",
	});
});

test("new public-copy creation retries, copies the returned URL, and reads back after save", async ({
	page,
}, testInfo) => {
	await page.goto(
		"/share-conversation-story.html?visibility=private&publishfail=once"
	);
	const origin = new URL(page.url()).origin;
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
		origin,
	});
	const dialog = page.getByTestId("share-conversation-dialog");
	const generalAccess = dialog.getByRole("combobox", {
		name: "General access",
	});
	await expect(generalAccess).toContainText("Restricted");
	await generalAccess.click();
	await page.getByRole("option", { name: "Anyone with the link" }).click();

	const copyLink = dialog.getByRole("button", { name: "Copy link" });
	await expect(copyLink).toBeEnabled();
	await copyLink.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Fixture public copy update failed."
	);
	await expect(copyLink).toBeEnabled();

	await copyLink.click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("https://ryu.test/share/story-token");
	const copiedToast = page.getByText("Share link copied", { exact: true });
	await expect(copiedToast).toBeVisible();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expect(
		dialog.getByRole("button", { name: "Update copy" })
	).toBeEnabled();

	const exactBody = {
		messages: [
			{
				content: "Can we share this rollout plan?",
				created_at: 1_724_000_000_000,
				id: "message-1",
				role: "user",
			},
			{
				content:
					"Yes — I’ve separated the public milestones from the internal notes.",
				created_at: 1_724_000_010_000,
				id: "message-2",
				role: "assistant",
			},
		],
		title: "Launch readiness and rollout plan",
	};
	let calls = await apiCalls(page);
	const firstCopyWrites = calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/conversation-shares/conversation/conversation-1"
	);
	expect(firstCopyWrites).toEqual([
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
	]);
	expect(
		calls.filter(
			(call) =>
				call.method === "PUT" &&
				call.path === "/api/conversations/conversation-1/access"
		)
	).toHaveLength(0);

	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
	calls = await apiCalls(page);
	expect(
		calls.filter(
			(call) =>
				call.method === "PUT" &&
				call.path === "/api/conversations/conversation-1/access"
		)
	).toEqual([
		{
			body: {
				collaborators: [{ role: "viewer", user_id: "user-noor" }],
				team_id: null,
				visibility: "private",
			},
			method: "PUT",
			path: "/api/conversations/conversation-1/access",
		},
	]);
	expect(
		calls.filter(
			(call) =>
				call.method === "PUT" &&
				call.path === "/api/conversation-shares/conversation/conversation-1"
		)
	).toEqual([
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
		{
			body: exactBody,
			method: "PUT",
			path: "/api/conversation-shares/conversation/conversation-1",
		},
	]);
	await expect(copiedToast).toBeVisible();
	await expect(
		page.getByText("Sharing settings saved", { exact: true })
	).toBeVisible();
	const createdCopy = await capture(
		page,
		"desktop-share-conversation-created-copy-readback.png"
	);
	await testInfo.attach("created-copy-readback.png", {
		body: createdCopy,
		contentType: "image/png",
	});

	await page.getByRole("button", { name: "Open sharing" }).click();
	await expect(generalAccess).toContainText("Anyone with the link");
	await expect(
		dialog.getByRole("button", { name: "Update copy" })
	).toBeEnabled();
	await dialog.getByRole("button", { name: "Copy link" }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("https://ryu.test/share/story-token");
});
