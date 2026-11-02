// Continues share-conversation-story.spec.ts (split under the file token limit); helpers live in share-conversation-story.helpers.ts.

import { expect, test } from "@playwright/test";
import { apiCalls, capture } from "./share-conversation-story.helpers.ts";

test.describe.configure({ timeout: 90_000 });

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
