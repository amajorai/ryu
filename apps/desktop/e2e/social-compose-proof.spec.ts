import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
	Draft,
	DraftBody,
	ScheduledPost,
	SocialAccount,
} from "../../../apps-store/social/ui/src/types.ts";

const evidenceDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const initialDraftText =
	"A fixture-backed Social draft with its selected target.";
const editedDraftText = "The same saved draft survives reopening and editing.";
const publishNowText = "Queue this now without contacting a provider.";

interface SocialBridgeCall {
	body?: unknown;
	method: string;
	path: string;
}

interface DraftListResponse {
	drafts: Draft[];
}

interface PostListResponse {
	posts: ScheduledPost[];
}

interface AccountListResponse {
	accounts: SocialAccount[];
}

declare global {
	interface Window {
		__socialComposeProof?: { calls: SocialBridgeCall[] };
	}
}

// The test bridge is installed by the host before the compiled Companion script.
// Keep the alternate mount-context URL in the test helper: it simulates Core
// reopening the production Companion directly on the Library panel.
async function openLibraryContext(page: Page) {
	await page.goto("/?section=library");
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
}

async function readDrafts(page: Page) {
	const response = await page.request.get(
		"/__social/drafts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/drafts unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust Draft records under the drafts key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	return (await response.json()) as DraftListResponse;
}

async function readPosts(page: Page) {
	const response = await page.request.get(
		"/__social/posts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/posts unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust ScheduledPost records under the posts key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	return (await response.json()) as PostListResponse;
}

async function bridgeCalls(page: Page) {
	return page.evaluate(() => window.__socialComposeProof?.calls ?? []);
}

function writeCalls(calls: SocialBridgeCall[]) {
	return calls.filter(
		(call) =>
			["POST", "PATCH", "DELETE"].includes(call.method) &&
			(call.path === "/drafts" ||
				call.path.startsWith("/drafts/") ||
				call.path === "/posts")
	);
}

async function seededAccount(page: Page) {
	const response = await page.request.get(
		"/__social/accounts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This helper first requires a successful response from the private host, which forwards /__social/accounts unchanged to the rebuilt native ryu-social list handler. That handler serializes concrete Rust SocialAccount records under the accounts key; the imported UI wire type mirrors those actual serde fields/enums/nulls. This is the controlled native endpoint contract, not arbitrary JSON validation.
	const body = (await response.json()) as AccountListResponse;
	expect(body.accounts).toHaveLength(1);
	return body.accounts[0];
}

function draftWriteBody(text: string, accountId: string): DraftBody {
	return {
		account_ids: [accountId],
		media: [],
		schema_version: 2,
		segments: [{ media: [], text }],
		text,
	};
}

async function makeScheduleValue(page: Page) {
	return page.evaluate(() => {
		const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
		date.setSeconds(0, 0);
		const pad = (value: number) => String(value).padStart(2, "0");
		return {
			at: date.getTime(),
			value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
		};
	});
}

async function clickAndObserveDisabled(button: Locator) {
	const disabledWhilePending = button.evaluate(
		(element) =>
			new Promise<boolean>((resolve) => {
				const target =
					/* SAFETY: The only callers pass the actual mounted ComposePanel Save draft and Schedule native Button locators to this pending-state observer. Those authored controls use the default native button, whose disabled property is observed; no arbitrary Locator element is admitted. */ element as HTMLButtonElement;
				let observer: MutationObserver | null = null;
				let timer: number | undefined;
				const finish = (disabled: boolean) => {
					observer?.disconnect();
					if (timer !== undefined) {
						clearTimeout(timer);
					}
					resolve(disabled);
				};
				observer = new MutationObserver(() => {
					if (target.disabled) {
						finish(true);
					}
				});
				observer.observe(target, {
					attributes: true,
					attributeFilter: ["disabled"],
				});
				if (target.disabled) {
					finish(true);
					return;
				}
				timer = globalThis.setTimeout(() => finish(target.disabled), 1500);
			})
	);
	const click = button.click();
	const disabled = await disabledWhilePending;
	await click;
	return disabled;
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDirectory, filename),
	});
}

test("compose saves and reopens one draft, schedules exact state, and queues publish only after confirmation", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	const account = await seededAccount(page);
	expect(account.account_label).toBe("@compose-proof");
	expect(account.platform).toBe("bluesky");
	expect(account.connected).toBe(false);

	const target = page.getByRole("checkbox", { name: "@compose-proof" });
	const scheduleButton = page.getByRole("button", {
		name: "Schedule",
		exact: true,
	});
	const publishButton = page.getByRole("button", {
		name: "Publish now",
		exact: true,
	});
	const saveDraftButton = page.getByRole("button", {
		name: "Save draft",
		exact: true,
	});
	const postText = page.getByRole("textbox", { name: "Post text" });
	const scheduleInput = page.getByLabel("Schedule for", { exact: true });

	await expect(scheduleButton).toBeDisabled();
	await target.click();
	await expect(target).toBeChecked();
	await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "you connect them" })
	).toBeVisible();
	await postText.fill(initialDraftText);
	await expect(saveDraftButton).toBeEnabled();
	await expect(scheduleButton).toBeEnabled();
	await expect(publishButton).toBeEnabled();
	await saveScreenshot(page, "social-compose-before-save.png");

	const failDraft = await page.request.post("/__proof/fail-draft");
	expect(failDraft.ok()).toBe(true);
	const disabledDuringDraftWrite =
		await clickAndObserveDisabled(saveDraftButton);
	expect(disabledDuringDraftWrite).toBe(true);
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture rejected the first draft write." })
	).toBeVisible();
	await expect(postText).toHaveValue(initialDraftText);
	expect((await readDrafts(page)).drafts).toHaveLength(0);
	const failedDraftCalls = (await bridgeCalls(page)).filter(
		(call) => call.path === "/drafts" && call.method === "POST"
	);
	expect(failedDraftCalls).toHaveLength(1);
	expect(failedDraftCalls[0].body).toEqual({
		body: draftWriteBody(initialDraftText, account.id),
		workspace_id: "default",
	});

	await saveDraftButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Draft saved" }).last()
	).toContainText("Draft saved");
	const firstDrafts = await readDrafts(page);
	expect(firstDrafts.drafts).toHaveLength(1);
	const savedDraft = firstDrafts.drafts[0];
	expect(savedDraft.workspace_id).toBe("default");
	expect(savedDraft.body).toEqual(draftWriteBody(initialDraftText, account.id));
	const draftCreateCalls = (await bridgeCalls(page)).filter(
		(call) => call.path === "/drafts" && call.method === "POST"
	);
	expect(draftCreateCalls).toHaveLength(2);
	expect(draftCreateCalls[1].body).toEqual({
		body: draftWriteBody(initialDraftText, account.id),
		workspace_id: "default",
	});
	await saveScreenshot(page, "social-compose-draft-saved.png");

	const writesBeforeNoticeSettings = writeCalls(await bridgeCalls(page));
	await page.getByRole("button", { name: "you connect them" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	expect(writeCalls(await bridgeCalls(page))).toEqual(
		writesBeforeNoticeSettings
	);
	await openLibraryContext(page);
	await page.getByRole("button", { name: "Compose", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	await expect(postText).toHaveValue(initialDraftText);
	await expect(target).toBeChecked();
	await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();

	await postText.fill("x".repeat(400));
	await expect(scheduleButton).toBeDisabled();
	await expect(publishButton).toBeDisabled();
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "One or more platforms reject this post" })
	).toBeVisible();
	await postText.fill(editedDraftText);
	await expect(scheduleButton).toBeEnabled();
	await expect(publishButton).toBeEnabled();
	await saveDraftButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Draft saved" }).last()
	).toContainText("Draft saved");
	const editedDraft = (await readDrafts(page)).drafts;
	expect(editedDraft).toHaveLength(1);
	expect(editedDraft[0].id).toBe(savedDraft.id);
	expect(editedDraft[0].body).toEqual(
		draftWriteBody(editedDraftText, account.id)
	);
	const editCalls = (await bridgeCalls(page)).filter(
		(call) =>
			call.path === `/drafts/${savedDraft.id}` && call.method === "PATCH"
	);
	expect(editCalls.at(-1)?.body).toEqual({
		body: draftWriteBody(editedDraftText, account.id),
	});

	await scheduleInput.fill("");
	await expect(scheduleButton).toBeEnabled();
	await scheduleButton.click();
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Pick a valid date and time first" })
	).toBeVisible();
	expect((await readPosts(page)).posts).toHaveLength(0);

	const scheduledAt = await makeScheduleValue(page);
	await scheduleInput.fill(scheduledAt.value);
	const failPost = await page.request.post("/__proof/fail-post");
	expect(failPost.ok()).toBe(true);
	const disabledDuringSchedule = await clickAndObserveDisabled(scheduleButton);
	expect(disabledDuringSchedule).toBe(true);
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture rejected the first schedule write." })
	).toBeVisible();
	await expect(postText).toHaveValue(editedDraftText);
	expect((await readPosts(page)).posts).toHaveLength(0);
	const draftAfterFailedSchedule = (await readDrafts(page)).drafts;
	expect(draftAfterFailedSchedule).toHaveLength(1);
	expect(draftAfterFailedSchedule[0].body).toEqual(
		draftWriteBody(editedDraftText, account.id)
	);

	await expect(scheduleButton).toBeEnabled();
	await saveScreenshot(page, "social-compose-schedule-ready.png");
	await scheduleButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Scheduled" }).last()
	).toContainText("Scheduled");
	const scheduledPosts = (await readPosts(page)).posts;
	expect(scheduledPosts).toHaveLength(1);
	const scheduledPost = scheduledPosts[0];
	expect(scheduledPost.workspace_id).toBe("default");
	expect(scheduledPost.draft_id).toBe(savedDraft.id);
	expect(scheduledPost.scheduled_for).toBe(scheduledAt.at);
	expect(scheduledPost.status).toBe("scheduled");
	expect(scheduledPost.targets).toHaveLength(1);
	expect(scheduledPost.targets[0].social_account_id).toBe(account.id);
	const scheduleCalls = (await bridgeCalls(page)).filter(
		(call) => call.path === "/posts" && call.method === "POST"
	);
	expect(scheduleCalls).toHaveLength(2);
	expect(scheduleCalls[0].body).toEqual({
		account_ids: [account.id],
		draft_id: savedDraft.id,
		scheduled_for: scheduledAt.at,
		workspace_id: "default",
	});
	expect(scheduleCalls[1].body).toEqual(scheduleCalls[0].body);
	await expect(postText).toHaveValue("");
	await expect(target).toBeChecked();

	await postText.fill(publishNowText);
	const writesBeforeConfirmDialog = writeCalls(await bridgeCalls(page));
	await publishButton.click();
	const confirm = page.getByRole("dialog");
	await expect(
		confirm.getByRole("heading", { name: "Publish now?" })
	).toBeVisible();
	await expect(confirm).toContainText("This goes to 1 account on Bluesky");
	await expect(confirm).toContainText(
		"The scheduler is off, so this post will be queued and stay there."
	);
	const postCountBeforeConfirm = (await readPosts(page)).posts.length;
	expect(postCountBeforeConfirm).toBe(1);
	expect(writeCalls(await bridgeCalls(page))).toEqual(
		writesBeforeConfirmDialog
	);
	await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });
	await saveScreenshot(page, "social-compose-publish-confirm.png");

	await page.keyboard.press("Escape");
	await expect(confirm).toBeHidden();
	expect((await readPosts(page)).posts).toHaveLength(postCountBeforeConfirm);
	expect(writeCalls(await bridgeCalls(page))).toEqual(
		writesBeforeConfirmDialog
	);
	await publishButton.click();
	const reopenedConfirm = page.getByRole("dialog");
	await expect(reopenedConfirm).toBeVisible();
	const writesBeforeSettingsAction = writeCalls(await bridgeCalls(page));
	await reopenedConfirm.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	expect((await readPosts(page)).posts).toHaveLength(postCountBeforeConfirm);
	expect(writeCalls(await bridgeCalls(page))).toEqual(
		writesBeforeSettingsAction
	);

	await page.goto("/?section=compose");
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	const reloadedTarget = page.getByRole("checkbox", { name: "@compose-proof" });
	await reloadedTarget.click();
	await page.getByRole("textbox", { name: "Post text" }).fill(publishNowText);
	const reloadedPublish = page.getByRole("button", {
		name: "Publish now",
		exact: true,
	});
	await reloadedPublish.click();
	const cancelDialog = page.getByRole("dialog");
	await expect(cancelDialog).toBeVisible();
	const writesBeforeCancel = writeCalls(await bridgeCalls(page));
	await cancelDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(cancelDialog).toBeHidden();
	expect((await readPosts(page)).posts).toHaveLength(postCountBeforeConfirm);
	expect(writeCalls(await bridgeCalls(page))).toEqual(writesBeforeCancel);

	await reloadedPublish.click();
	const finalDialog = page.getByRole("dialog");
	await expect(finalDialog).toBeVisible();
	const draftsBeforePublishNow = (await readDrafts(page)).drafts;
	const writesBeforePublishNow = writeCalls(await bridgeCalls(page));
	const beforePublishNow = Date.now();
	await finalDialog
		.getByRole("button", { name: "Publish now", exact: true })
		.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Publishing now" }).last()
	).toContainText("Publishing now");
	await expect(page.getByRole("textbox", { name: "Post text" })).toHaveValue(
		""
	);
	const allPosts = (await readPosts(page)).posts;
	expect(allPosts).toHaveLength(postCountBeforeConfirm + 1);
	const immediatePost = allPosts.find(
		(post) => post.draft_id !== savedDraft.id
	);
	expect(immediatePost).toBeDefined();
	expect(immediatePost?.status).toBe("scheduled");
	expect(immediatePost?.scheduled_for).toBeGreaterThanOrEqual(beforePublishNow);
	expect(immediatePost?.scheduled_for).toBeLessThanOrEqual(Date.now());
	expect(
		immediatePost?.targets.map((targetRow) => targetRow.social_account_id)
	).toEqual([account.id]);
	expect((await readDrafts(page)).drafts).toHaveLength(
		draftsBeforePublishNow.length + 1
	);
	const nowCalls = (await bridgeCalls(page)).filter(
		(call) => call.path === "/posts" && call.method === "POST"
	);
	const publishNowCall = nowCalls.at(-1);
	expect(publishNowCall?.body).toEqual({
		account_ids: [account.id],
		draft_id: immediatePost?.draft_id,
		workspace_id: "default",
	});
	expect(publishNowCall?.body).not.toHaveProperty("scheduled_for");
	expect(
		writeCalls(await bridgeCalls(page))
			.slice(writesBeforePublishNow.length)
			.map((call) => [call.method, call.path])
	).toEqual([
		["POST", "/drafts"],
		["POST", "/posts"],
	]);
	const settingsResponse = await page.request.get(
		"/__social/settings?workspace_id=default"
	);
	expect(settingsResponse.ok()).toBe(true);
	const settingsBody = await settingsResponse.json();
	expect(settingsBody.settings.scheduler_enabled).toBe(false);
	await saveScreenshot(page, "social-compose-publish-now-queued.png");

	await page.goto("/?section=queue");
	await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
	await expect(page.getByText("@compose-proof", { exact: true })).toHaveCount(
		2
	);
	await expect(page.getByText("Pending", { exact: true })).toHaveCount(2);
	await expect(page.getByText("Scheduled", { exact: true })).toHaveCount(2);
	await saveScreenshot(page, "social-compose-queue-persisted.png");
});
