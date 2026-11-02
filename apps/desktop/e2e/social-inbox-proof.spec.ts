import { expect, test } from "@playwright/test";
import {
	clickAndObserveDisabled,
	EXTERNAL_POST_URL,
	inboxQueries,
	installSocialFixture,
	mountInbox,
	pageErrors,
	rowFor,
	type SocialInboxProofWindow,
	saveEvidence,
	WORKSPACE_ID,
} from "./social-inbox-proof.helpers.ts";

declare const window: Window;

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(({ page }) => {
	expect(pageErrors.get(page)).toEqual([]);
});

test("Inbox selection updates read state; filters use their correct query boundary", async ({
	page,
}) => {
	const fixture = installSocialFixture(page);
	const inbox = await mountInbox(page);
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	await expect(rowFor(inbox, "@organizer")).toBeVisible();
	await rowFor(inbox, "@maya").click();
	await expect(
		inbox
			.getByText(
				"The launch thread is helpful. Could you share more about the timeline?",
				{ exact: true }
			)
			.last()
	).toBeVisible();
	await expect(
		inbox.getByRole("button", { name: "Mark unread", exact: true })
	).toBeVisible();
	await expect
		.poll(
			() =>
				fixture.requests.filter(
					(request) =>
						request.method === "POST" &&
						request.path === "/inbox/inbox-maya-comment/read"
				).length
		)
		.toBe(1);
	expect(
		fixture.requests.find(
			(request) =>
				request.method === "POST" &&
				request.path === "/inbox/inbox-maya-comment/read"
		)?.body
	).toEqual({ read: true });
	await inbox.getByRole("button", { name: "Mark unread", exact: true }).click();
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	await expect(
		inbox.getByRole("button", { name: "Mark read", exact: true })
	).toBeVisible();
	await expect
		.poll(
			() =>
				fixture.requests.filter(
					(request) =>
						request.method === "POST" &&
						request.path === "/inbox/inbox-maya-comment/read"
				).length
		)
		.toBe(2);
	expect(
		fixture.requests
			.filter(
				(request) =>
					request.method === "POST" &&
					request.path === "/inbox/inbox-maya-comment/read"
			)
			.map((request) => request.body)
	).toEqual([{ read: true }, { read: false }]);

	await inbox.getByRole("button", { name: "Unread only", exact: true }).click();
	await expect
		.poll(async () => (await inboxQueries(fixture)).at(-1)?.path)
		.toBe(`/inbox?workspace_id=${WORKSPACE_ID}&limit=200&unread=true`);
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	await expect(
		inbox
			.getByText(
				"The launch thread is helpful. Could you share more about the timeline?",
				{ exact: true }
			)
			.last()
	).toBeVisible();
	await expect(
		inbox.getByRole("button", { name: "Mark read", exact: true })
	).toBeVisible();

	await inbox.getByRole("button", { name: "Unread only", exact: true }).click();
	await expect
		.poll(async () => (await inboxQueries(fixture)).at(-1)?.path)
		.toBe(`/inbox?workspace_id=${WORKSPACE_ID}&limit=200`);

	const byKind = [
		["comment", "@maya"],
		["reply", "@lena"],
		["mention", "@riley"],
		["dm", "@organizer"],
	] as const;
	const kindFilter = inbox.getByLabel("Filter by kind", { exact: true });
	for (const [kind, author] of byKind) {
		await kindFilter.selectOption(kind);
		await expect
			.poll(async () => (await inboxQueries(fixture)).at(-1)?.path)
			.toBe(`/inbox?workspace_id=${WORKSPACE_ID}&kind=${kind}&limit=200`);
		await expect(rowFor(inbox, author)).toBeVisible();
	}

	await kindFilter.selectOption("all");
	await expect
		.poll(async () => (await inboxQueries(fixture)).at(-1)?.path)
		.toBe(`/inbox?workspace_id=${WORKSPACE_ID}&limit=200`);
	const queryCountBeforePlatform = (await inboxQueries(fixture)).length;
	const platformFilter = inbox.getByLabel("Filter by platform", {
		exact: true,
	});
	await platformFilter.selectOption("instagram");
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	await expect(rowFor(inbox, "@lena")).toBeVisible();
	await expect(rowFor(inbox, "@organizer")).toHaveCount(0);
	await platformFilter.selectOption("x");
	await expect(rowFor(inbox, "@organizer")).toBeVisible();
	await expect(rowFor(inbox, "@maya")).toHaveCount(0);
	await platformFilter.selectOption("all");
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	expect((await inboxQueries(fixture)).length).toBe(queryCountBeforePlatform);
	expect(
		(await inboxQueries(fixture)).every(
			(request) =>
				!new URLSearchParams(request.path.split("?")[1]).has("platform")
		)
	).toBe(true);
	await saveEvidence(
		page,
		"social-inbox-extension-host-filters-and-read-state.png"
	);
});

test("selected detail retains the latest read state when Unread only filters its row", async ({
	page,
}) => {
	const fixture = installSocialFixture(page);
	const inbox = await mountInbox(page);
	await rowFor(inbox, "@maya").click();
	await expect
		.poll(
			() =>
				fixture.requests.find(
					(request) =>
						request.method === "POST" &&
						request.path === "/inbox/inbox-maya-comment/read"
				)?.body
		)
		.toEqual({ read: true });
	await expect(
		inbox.getByRole("button", { name: "Mark unread", exact: true })
	).toBeVisible();
	await inbox.getByRole("button", { name: "Unread only", exact: true }).click();
	await expect
		.poll(async () => (await inboxQueries(fixture)).at(-1)?.path)
		.toBe(`/inbox?workspace_id=${WORKSPACE_ID}&limit=200&unread=true`);
	await expect(rowFor(inbox, "@maya")).toHaveCount(0);
	await saveEvidence(page, "social-inbox-filtered-detail-stale-read-state.png");
	await expect(
		inbox.getByRole("button", { name: "Mark unread", exact: true })
	).toBeVisible();
});

test("manual refresh reports a bridge failure, keeps items visible, and retries into new state", async ({
	page,
}) => {
	const fixture = installSocialFixture(page);
	const inbox = await mountInbox(page);
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	fixture.failNext({
		delayMs: 250,
		message: "Inbox refresh temporarily unavailable.",
		method: "POST",
		path: "/inbox/refresh",
		status: 503,
	});
	const refresh = inbox.getByRole("button", { name: "Refresh", exact: true });
	expect(await clickAndObserveDisabled(refresh)).toBe(true);
	await expect(
		inbox.getByRole("alert").filter({ hasText: "Could not sync the inbox" })
	).toBeVisible();
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	await expect(inbox.getByText("No items", { exact: true })).toHaveCount(0);
	const refreshCalls = fixture.requests.filter(
		(request) => request.method === "POST" && request.path === "/inbox/refresh"
	);
	expect(refreshCalls).toMatchObject([
		{
			body: { workspace_id: WORKSPACE_ID },
			method: "POST",
			path: "/inbox/refresh",
			status: 503,
		},
	]);
	await expect(refresh).toBeEnabled();

	await refresh.click();
	await expect(
		inbox.getByRole("status").filter({ hasText: "Inbox synced" })
	).toBeVisible();
	await expect(rowFor(inbox, "@kira")).toBeVisible();
	const retries = fixture.requests.filter(
		(request) => request.method === "POST" && request.path === "/inbox/refresh"
	);
	expect(retries.map((request) => request.body)).toEqual([
		{ workspace_id: WORKSPACE_ID },
		{ workspace_id: WORKSPACE_ID },
	]);
	expect(retries.map((request) => request.status)).toEqual([503, 200]);
	await expect(
		inbox
			.getByRole("status")
			.filter({ hasText: "1 new of 1 fetched · 3 accounts polled" })
	).toBeVisible();
	await saveEvidence(page, "social-inbox-extension-host-refresh-retry.png");
});

test("draft reply fills the composer only; send failure keeps text and retry persists the trimmed payload", async ({
	page,
}) => {
	const fixture = installSocialFixture(page);
	const inbox = await mountInbox(page);
	await rowFor(inbox, "@maya").click();
	const replyBox = inbox.getByRole("textbox", { name: "Reply to @maya" });
	const draftButton = inbox.getByRole("button", {
		name: "Draft a reply",
		exact: true,
	});
	await draftButton.click();
	await expect(replyBox).toHaveValue(
		"Thanks for sharing this — I will follow up shortly."
	);
	const modelCalls = await page.evaluate(() =>
		window.__socialInboxProof.modelCalls()
	);
	expect(modelCalls).toHaveLength(1);
	expect(modelCalls[0]?.prompt).toContain("Platform: Instagram");
	expect(modelCalls[0]?.prompt).toContain("Kind: Comment");
	expect(modelCalls[0]?.prompt).toContain("From: @maya");
	expect(modelCalls[0]?.system).toContain(
		"You draft short, plain replies to social-media engagement"
	);
	expect(
		fixture.requests.filter((request) => request.path.endsWith("/reply"))
	).toEqual([]);

	await replyBox.fill("  Thanks for the thoughtful note.  ");
	fixture.failNext({
		delayMs: 250,
		message: "Reply temporarily unavailable.",
		method: "POST",
		path: "/inbox/inbox-maya-comment/reply",
		status: 502,
	});
	const send = inbox.getByRole("button", { name: "Send", exact: true });
	expect(await clickAndObserveDisabled(send)).toBe(true);
	await expect(
		inbox.getByRole("alert").filter({ hasText: "Could not send the reply" })
	).toBeVisible();
	await expect(replyBox).toHaveValue("  Thanks for the thoughtful note.  ");
	await expect(rowFor(inbox, "@maya")).toBeVisible();
	const retries = fixture.requests.filter(
		(request) => request.path === "/inbox/inbox-maya-comment/reply"
	);
	expect(retries).toMatchObject([
		{
			body: { text: "Thanks for the thoughtful note." },
			method: "POST",
			path: "/inbox/inbox-maya-comment/reply",
			status: 502,
		},
	]);

	await send.click();
	await expect(
		inbox.getByRole("status").filter({ hasText: "Reply sent" })
	).toBeVisible();
	await expect(replyBox).toHaveValue("");
	await expect(
		inbox.getByText("Replied", { exact: true }).first()
	).toBeVisible();
	const replyCalls = fixture.requests.filter(
		(request) => request.path === "/inbox/inbox-maya-comment/reply"
	);
	expect(replyCalls.map((request) => request.body)).toEqual([
		{ text: "Thanks for the thoughtful note." },
		{ text: "Thanks for the thoughtful note." },
	]);
	expect(replyCalls.map((request) => request.status)).toEqual([502, 200]);
	expect(
		fixture.items.find((item) => item.id === "inbox-maya-comment")
	).toMatchObject({
		read: true,
		replied: true,
	});
	await saveEvidence(page, "social-inbox-extension-host-reply-recovery.png");
});

test("safe original links retain their exact HTTPS destination and unsafe schemes render no link", async ({
	page,
}) => {
	const fixture = installSocialFixture(page);
	const inbox = await mountInbox(page);
	await rowFor(inbox, "@maya").click();
	const original = inbox.getByRole("link", {
		name: "Open the original",
		exact: true,
	});
	await expect(original).toHaveAttribute("href", EXTERNAL_POST_URL);
	await expect(original).toHaveAttribute("target", "_blank");
	await expect(original).toHaveAttribute("rel", "noopener noreferrer");
	await saveEvidence(page, "social-inbox-extension-host-original-link.png");

	await rowFor(inbox, "@riley").click();
	await expect(
		inbox.getByText("This platform did not return a permalink for the item.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		inbox.getByRole("link", { name: "Open the original", exact: true })
	).toHaveCount(0);
	expect(
		fixture.requests.some((request) => request.path.includes("javascript:"))
	).toBe(false);
});

test("the original-post link hands its safe HTTPS destination to the host without navigating", async ({
	page,
}) => {
	installSocialFixture(page);
	const inbox = await mountInbox(page);
	await rowFor(inbox, "@maya").click();
	const original = inbox.getByRole("link", {
		name: "Open the original",
		exact: true,
	});
	await expect(original).toHaveAttribute("href", EXTERNAL_POST_URL);
	await expect(original).toHaveAttribute("rel", "noopener noreferrer");
	const externalRequests: string[] = [];
	await page.context().route("https://social.example/**", async (route) => {
		externalRequests.push(route.request().url());
		await route.abort();
	});
	const pageUrl = page.url();
	const popupPromise = page
		.waitForEvent("popup", { timeout: 750 })
		.catch(() => null);
	await original.click();
	const popup = await popupPromise;
	expect(popup).toBeNull();
	await expect
		.poll(() =>
			page.evaluate(() =>
				/* SAFETY: social-inbox-proof.tsx installs __socialInboxProof before this proof page is evaluated. */ (
					window as SocialInboxProofWindow
				).__socialInboxProof.externalLinkCalls()
			)
		)
		.toEqual([{ href: EXTERNAL_POST_URL }]);
	expect(page.url()).toBe(pageUrl);
	expect(externalRequests).toEqual([]);
});

test("an initial inbox read failure is not presented as an empty inbox", async ({
	page,
}) => {
	const fixture = installSocialFixture(page);
	fixture.failNext({
		message: "Inbox list temporarily unavailable.",
		method: "GET",
		path: "/inbox",
		status: 503,
	});
	const inbox = await mountInbox(page);
	// The heading renders before the first inbox read settles; wait for the
	// refused read and its error state instead of sampling a loading frame.
	await expect
		.poll(
			() =>
				fixture.requests.find(
					(request) =>
						request.method === "GET" && request.path.startsWith("/inbox?")
				)?.status
		)
		.toBe(503);
	await expect(inbox.getByText("Could not read the inbox")).toBeVisible();
	await expect(
		inbox.getByText("Inbox list temporarily unavailable.")
	).toBeVisible();
	await saveEvidence(page, "social-inbox-initial-fetch-error-state.png");
	await expect(inbox.getByText("No items", { exact: true })).toHaveCount(0);
});
