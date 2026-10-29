import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
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

interface SocialBridgeCall {
	body?: unknown;
	method?: string;
	path: string;
}

declare global {
	interface Window {
		__socialCalendarEntryProof?: { calls: SocialBridgeCall[] };
	}
}

async function createAccount(page: Page, accountLabel: string) {
	const response = await page.request.post("/__social/accounts", {
		data: {
			account_label: accountLabel,
			platform: "bluesky",
			workspace_id: "default",
		},
	});
	expect(response.ok()).toBe(true);
	// SAFETY: This successful private POST /__social/accounts is forwarded unchanged to native ryu-social create_account, which serializes the complete Rust SocialAccount directly. The imported UI type mirrors those serde fields/enums/nulls; this host only overrides post PATCH responses elsewhere.
	return (await response.json()) as SocialAccount;
}

async function createDraft(
	page: Page,
	accountId: string,
	text: string
): Promise<{ body: DraftBody; draft: Draft }> {
	const body: DraftBody = {
		account_ids: [accountId],
		media: [],
		schema_version: 2,
		segments: [{ media: [], text }],
		text,
	};
	const response = await page.request.post("/__social/drafts", {
		data: { body, workspace_id: "default" },
	});
	expect(response.ok()).toBe(true);
	return { body, draft: await response.json() };
}

async function createScheduledPost(
	page: Page,
	accountId: string,
	draftId: string,
	scheduledFor: number
): Promise<ScheduledPost> {
	const response = await page.request.post("/__social/posts", {
		data: {
			account_ids: [accountId],
			draft_id: draftId,
			scheduled_for: scheduledFor,
			workspace_id: "default",
		},
	});
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function readPost(page: Page, postId: string): Promise<ScheduledPost> {
	const response = await page.request.get(`/__social/posts/${postId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function listPosts(page: Page): Promise<ScheduledPost[]> {
	const response = await page.request.get(
		"/__social/posts?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.posts;
}

async function readDraft(page: Page, draftId: string): Promise<Draft> {
	const response = await page.request.get(`/__social/drafts/${draftId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function localDateTimeAfter(
	page: Page,
	base: number,
	days: number,
	hour: number,
	minute: number
): Promise<string> {
	return page.evaluate(
		({ baseAt, dayDelta, hourValue, minuteValue }) => {
			const date = new Date(baseAt);
			date.setDate(date.getDate() + dayDelta);
			date.setHours(hourValue, minuteValue, 0, 0);
			const pad = (value: number) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
		},
		{
			baseAt: base,
			dayDelta: days,
			hourValue: hour,
			minuteValue: minute,
		}
	);
}

async function epochForLocalDateTime(page: Page, value: string) {
	return page.evaluate((localValue) => new Date(localValue).getTime(), value);
}

async function localDateTimeValue(page: Page, at: number) {
	return page.evaluate((timestamp) => {
		const date = new Date(timestamp);
		const pad = (value: number) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}, at);
}

async function addLocalDays(page: Page, base: number, days: number) {
	return page.evaluate(
		({ baseAt, dayDelta }) => {
			const date = new Date(baseAt);
			date.setDate(date.getDate() + dayDelta);
			return date.getTime();
		},
		{ baseAt: base, dayDelta: days }
	);
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidenceDirectory, filename),
	});
}

async function clearTransientToasts(page: Page) {
	await expect(page.getByRole("status")).toHaveCount(0);
}

async function openEntry(page: Page, title: string) {
	await page.getByText(title, { exact: true }).click();
}

test("entry triggers edit schedule, reject bad times, recover, duplicate, and compose", async ({
	page,
}) => {
	const account = await createAccount(page, "Calendar popover QA");
	const title = "Calendar reschedule proof post";
	const { body: draftBody, draft } = await createDraft(page, account.id, title);
	const initialAt = await page.evaluate(() => {
		const date = new Date();
		date.setMinutes(date.getMinutes() + 10, 0, 0);
		return date.getTime();
	});
	const post = await createScheduledPost(page, account.id, draft.id, initialAt);

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
	const crossesMonth = await page.evaluate((scheduledAt) => {
		const now = new Date();
		const scheduled = new Date(scheduledAt);
		return (
			now.getFullYear() !== scheduled.getFullYear() ||
			now.getMonth() !== scheduled.getMonth()
		);
	}, initialAt);
	if (crossesMonth) {
		await page.getByRole("button", { name: "Next", exact: true }).click();
	}

	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	await expect(page.getByLabel("New date and time")).toHaveValue(
		await localDateTimeValue(page, initialAt)
	);
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("New date and time")).toBeHidden();

	await page.getByRole("button", { name: "Week", exact: true }).click();
	const crossesWeek = await page.evaluate((scheduledAt) => {
		const weekStart = (value: Date) => {
			const day = (value.getDay() + 6) % 7;
			value.setHours(0, 0, 0, 0);
			value.setDate(value.getDate() - day);
			return value.getTime();
		};
		return weekStart(new Date(scheduledAt)) > weekStart(new Date());
	}, initialAt);
	if (crossesWeek) {
		await page.getByRole("button", { name: "Next", exact: true }).click();
	}
	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("New date and time")).toBeHidden();

	await page.getByRole("button", { name: "Agenda", exact: true }).click();
	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	const moveButton = page.getByRole("button", { name: "Move", exact: true });
	const dateInput = page.getByLabel("New date and time");
	await dateInput.fill("");
	await expect(moveButton).toBeDisabled();
	const patchCountBeforeInvalid = await page.evaluate(
		(postId) =>
			(window.__socialCalendarEntryProof?.calls ?? []).filter(
				(call) => call.method === "PATCH" && call.path === `/posts/${postId}`
			).length,
		post.id
	);
	expect(patchCountBeforeInvalid).toBe(0);

	const requestedDateTime = await localDateTimeAfter(
		page,
		initialAt,
		2,
		15,
		42
	);
	const requestedAt = await epochForLocalDateTime(page, requestedDateTime);
	await dateInput.fill(requestedDateTime);
	await expect(moveButton).toBeEnabled();
	const failFirstMove = await page.request.post(
		"/__proof/fail-next-reschedule"
	);
	expect(failFirstMove.ok()).toBe(true);
	await moveButton.click();
	const moveError = page.getByRole("alert");
	await expect(moveError).toContainText("Rescheduled failed");
	await expect(moveError).toContainText(
		"Fixture rejected the first reschedule."
	);
	await expect(dateInput).toHaveValue(requestedDateTime);
	expect((await readPost(page, post.id)).scheduled_for).toBe(initialAt);

	await moveButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Rescheduled" }).last()
	).toContainText("Rescheduled");
	await expect(dateInput).toBeHidden();
	let saved = await readPost(page, post.id);
	expect(saved.scheduled_for).toBe(requestedAt);

	const moveTimes = [requestedAt];
	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	await expect(dateInput).toHaveValue(requestedDateTime);
	await page.getByRole("button", { name: "+1h", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Rescheduled" }).last()
	).toContainText("Rescheduled");
	await expect(dateInput).toBeHidden();
	saved = await readPost(page, post.id);
	const plusHourAt = requestedAt + 3_600_000;
	expect(saved.scheduled_for).toBe(plusHourAt);
	moveTimes.push(plusHourAt);

	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	await page.getByRole("button", { name: "+1d", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Rescheduled" }).last()
	).toContainText("Rescheduled");
	await expect(dateInput).toBeHidden();
	saved = await readPost(page, post.id);
	const plusDayAt = await addLocalDays(page, plusHourAt, 1);
	expect(saved.scheduled_for).toBe(plusDayAt);
	moveTimes.push(plusDayAt);

	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	await page.getByRole("button", { name: "+1w", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Rescheduled" }).last()
	).toContainText("Rescheduled");
	await expect(dateInput).toBeHidden();
	saved = await readPost(page, post.id);
	const plusWeekAt = await addLocalDays(page, plusDayAt, 7);
	expect(saved.scheduled_for).toBe(plusWeekAt);
	moveTimes.push(plusWeekAt);

	await openEntry(page, title);
	await expect(dateInput).toHaveValue(
		await localDateTimeValue(page, plusWeekAt)
	);
	await expect(
		page.getByRole("button", { name: "Delete", exact: true })
	).toHaveCount(0);
	const moveRequests = await page.evaluate(
		(postId) =>
			(window.__socialCalendarEntryProof?.calls ?? []).filter(
				(call) => call.method === "PATCH" && call.path === `/posts/${postId}`
			),
		post.id
	);
	expect(moveRequests).toHaveLength(5);
	expect(moveRequests.map((call) => call.body)).toEqual(
		[requestedAt, requestedAt, ...moveTimes.slice(1)].map((scheduled_for) => ({
			scheduled_for,
		}))
	);
	await clearTransientToasts(page);
	await dateInput.evaluate((input) => {
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected proof element to be an HTMLInputElement.");
		}
		return input.blur();
	});
	await saveScreenshot(page, "social-calendar-entry-popover-rescheduled.png");
	await page
		.getByRole("button", { name: "Compose", exact: true })
		.last()
		.click();
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Post text" })).toHaveValue(
		""
	);

	await page.reload();
	await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
	await page.getByRole("button", { name: "Agenda", exact: true }).click();
	await openEntry(page, title);
	await expect(page.getByLabel("New date and time")).toBeVisible();
	await page.getByRole("button", { name: "Duplicate", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Duplicated" }).last()
	).toContainText("Duplicated");

	const duplicateExpectedAt = await addLocalDays(page, plusWeekAt, 1);
	const posts = await listPosts(page);
	const duplicatedPosts = posts.filter((candidate) => candidate.id !== post.id);
	expect(duplicatedPosts).toHaveLength(1);
	const duplicated = duplicatedPosts[0];
	expect(duplicated).toMatchObject({
		draft_id: expect.any(String),
		scheduled_for: duplicateExpectedAt,
		status: "scheduled",
		workspace_id: "default",
	});
	expect(duplicated.draft_id).not.toBe(draft.id);
	expect((await readDraft(page, duplicated.draft_id ?? "")).body).toEqual(
		draftBody
	);

	const calls = await page.evaluate(
		() => window.__socialCalendarEntryProof?.calls ?? []
	);
	const duplicateRequest = calls
		.filter((call) => call.method === "POST" && call.path === "/posts")
		.at(-1);
	expect(duplicateRequest?.body).toEqual({
		account_ids: [account.id],
		body: { ...draftBody, account_ids: [account.id] },
		scheduled_for: duplicateExpectedAt,
	});

	await page.reload();
	await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
	await page.getByRole("button", { name: "Agenda", exact: true }).click();
	await page.getByText(title, { exact: true }).first().click();
	await expect(dateInput).toHaveValue(
		await localDateTimeValue(page, plusWeekAt)
	);
	const reloaded = await readPost(page, post.id);
	expect(reloaded.scheduled_for).toBe(plusWeekAt);
});

test("cancel, publish-now, retry, and published permalink controls match persisted state", async ({
	page,
}) => {
	const account = await createAccount(page, "Calendar state QA");
	const cancelTitle = "Calendar cancellation proof";
	const publishTitle = "Calendar publish-now proof";
	const retryTitle = "Calendar retry proof";
	const cancelDraft = await createDraft(page, account.id, cancelTitle);
	const publishDraft = await createDraft(page, account.id, publishTitle);
	const retryDraft = await createDraft(page, account.id, retryTitle);
	const now = await page.evaluate(() => Date.now());
	const cancelPost = await createScheduledPost(
		page,
		account.id,
		cancelDraft.draft.id,
		now + 2 * 86_400_000
	);
	const publishPost = await createScheduledPost(
		page,
		account.id,
		publishDraft.draft.id,
		now + 3 * 86_400_000
	);
	const retryPost = await createScheduledPost(
		page,
		account.id,
		retryDraft.draft.id,
		now + 4 * 86_400_000
	);
	const seededFailure = await page.request.post("/__proof/seed-failed-post", {
		data: { postId: retryPost.id, targetId: retryPost.targets[0]?.id },
	});
	expect(seededFailure.ok()).toBe(true);
	expect((await readPost(page, retryPost.id)).status).toBe("failed");

	const permalink = "https://bsky.app/profile/fixture.example/post/entry-proof";
	const publishedTitle = "Published calendar permalink proof";
	const seededActivity = await page.request.post(
		"/__proof/seed-published-activity",
		{
			data: {
				accountId: account.id,
				permalink,
				publishedAt: now,
				text: publishedTitle,
			},
		}
	);
	expect(seededActivity.ok()).toBe(true);
	const unsafeTitle = "Unsafe published link must stay inert";
	const unsafeActivity = await page.request.post(
		"/__proof/seed-published-activity",
		{
			data: {
				accountId: account.id,
				permalink: "javascript:alert(1)",
				publishedAt: now,
				text: unsafeTitle,
			},
		}
	);
	expect(unsafeActivity.ok()).toBe(true);

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
	await page.getByRole("button", { name: "Agenda", exact: true }).click();

	await openEntry(page, cancelTitle);
	await expect(
		page.getByRole("button", { name: "Cancel", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Cancelled" }).last()
	).toContainText("Cancelled");
	const cancelled = await readPost(page, cancelPost.id);
	expect(cancelled.status).toBe("cancelled");
	expect(cancelled.targets[0]?.status).toBe("cancelled");

	await openEntry(page, publishTitle);
	await page.getByRole("button", { name: "Publish now", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Queued to publish" }).last()
	).toContainText("Queued to publish");
	const due = await readPost(page, publishPost.id);
	expect(due.status).toBe("due");
	expect(due.scheduled_for).toBeLessThanOrEqual(Date.now());
	await openEntry(page, publishTitle);
	await expect(
		page.getByRole("button", { name: "Publish now", exact: true })
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Cancel", exact: true })
	).toBeVisible();
	await expect(page.getByLabel("New date and time")).toBeHidden();
	await page.keyboard.press("Escape");

	await openEntry(page, retryTitle);
	await expect(
		page.getByRole("button", { name: "Retry", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete", exact: true })
	).toHaveCount(0);
	await clearTransientToasts(page);
	await saveScreenshot(page, "social-calendar-entry-popover-failed-retry.png");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("status").filter({ hasText: "Re-queued" }).last()
	).toContainText("Re-queued");
	const retried = await readPost(page, retryPost.id);
	expect(retried.status).toBe("due");
	expect(retried.targets[0]).toMatchObject({
		attempts: 0,
		claimed_at: null,
		status: "pending",
	});

	await openEntry(page, publishedTitle);
	const externalLink = page.getByRole("link", { name: permalink, exact: true });
	await expect(externalLink).toHaveAttribute("target", "_blank");
	await expect(externalLink).toHaveAttribute("rel", /noopener/);
	await expect(
		page.getByRole("button", { name: "Retry", exact: true })
	).toHaveCount(0);
	await expect(page.getByLabel("New date and time")).toHaveCount(0);
	await clearTransientToasts(page);
	await saveScreenshot(
		page,
		"social-calendar-entry-popover-published-link.png"
	);
	await page.context().route("https://bsky.app/**", (route) =>
		route.fulfill({
			body: "Local fixture for the public permalink target.",
			contentType: "text/plain",
			status: 200,
		})
	);
	const [permalinkPage] = await Promise.all([
		page.context().waitForEvent("page"),
		externalLink.click(),
	]);
	await expect(permalinkPage).toHaveURL(permalink);
	await permalinkPage.close();

	await page.keyboard.press("Escape");
	await openEntry(page, unsafeTitle);
	await expect(
		page.getByRole("link", { name: "javascript:alert(1)", exact: true })
	).toHaveCount(0);

	const calls = await page.evaluate(
		() => window.__socialCalendarEntryProof?.calls ?? []
	);
	expect(
		calls.some(
			(call) =>
				call.method === "POST" && call.path === `/posts/${cancelPost.id}/cancel`
		)
	).toBe(true);
	expect(
		calls.some(
			(call) =>
				call.method === "POST" &&
				call.path === `/posts/${publishPost.id}/publish-now`
		)
	).toBe(true);
	expect(
		calls.some(
			(call) =>
				call.method === "POST" && call.path === `/posts/${retryPost.id}/retry`
		)
	).toBe(true);
});
