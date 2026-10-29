import { tmpdir } from "node:os";
import { z } from "zod";

declare const window: Window;

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
	expect,
	type FrameLocator,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import type {
	InboxItem,
	Platform,
	PlatformInfo,
	SocialAccount,
} from "../../../apps-store/social/ui/src/types.ts";

const WORKSPACE_ID = "ws-inbox-proof";
const SOCIAL_BUNDLE = path.join(tmpdir(), "ryu-social-inbox-build/index.html");
const EXTERNAL_POST_URL = "https://social.example/posts/original-42";
const EVIDENCE_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface RecordedRequest {
	body?: unknown;
	method: string;
	path: string;
	status: number;
}

interface PendingFailure {
	delayMs?: number;
	message: string;
	method: string;
	path: string;
	status: number;
}

interface SocialFixture {
	accounts: SocialAccount[];
	failNext: (failure: PendingFailure) => void;
	items: InboxItem[];
	platforms: PlatformInfo[];
	requests: RecordedRequest[];
}

type SocialInboxProofWindow = Window;

function platformInfo(platform: Platform, label: string): PlatformInfo {
	return {
		capabilities: {
			publish: true,
			read_comments: true,
			read_dms: true,
			read_engagement: true,
			schedule: false,
			send_dm: true,
		},
		label,
		limits: {
			allowed_mime_prefixes: ["image/"],
			max_chars: 2200,
			max_media: 4,
			max_segments: 1,
			segment_style: "none",
		},
		platform,
	};
}

function createItem(input: {
	author: string;
	externalId: string;
	id: string;
	kind: InboxItem["kind"];
	permalink: string | null;
	platform: Platform;
	read: boolean;
	socialAccountId: string;
	text: string;
	replied?: boolean;
}): InboxItem {
	return {
		author: input.author,
		external_id: input.externalId,
		id: input.id,
		kind: input.kind,
		permalink: input.permalink,
		platform: input.platform,
		read: input.read,
		received_at: Date.now() - 60_000,
		replied: input.replied ?? false,
		social_account_id: input.socialAccountId,
		text: input.text,
		workspace_id: WORKSPACE_ID,
	};
}

function createSocialFixture(): SocialFixture {
	const createdAt = Date.now() - 86_400_000;
	return {
		accounts: [
			{
				account_label: "@outpost-team",
				connected: true,
				created_at: createdAt,
				external_id: "instagram-account-17",
				id: "account-instagram",
				platform: "instagram",
				workspace_id: WORKSPACE_ID,
			},
			{
				account_label: "@outpost-x",
				connected: true,
				created_at: createdAt,
				external_id: "x-account-8",
				id: "account-x",
				platform: "x",
				workspace_id: WORKSPACE_ID,
			},
			{
				account_label: "@outpost-bsky",
				connected: true,
				created_at: createdAt,
				external_id: "did:plc:outpost",
				id: "account-bluesky",
				platform: "bluesky",
				workspace_id: WORKSPACE_ID,
			},
		],
		failNext: () => undefined,
		items: [
			createItem({
				author: "@maya",
				externalId: "remote-comment-42",
				id: "inbox-maya-comment",
				kind: "comment",
				permalink: EXTERNAL_POST_URL,
				platform: "instagram",
				read: false,
				socialAccountId: "account-instagram",
				text: "The launch thread is helpful. Could you share more about the timeline?",
			}),
			createItem({
				author: "@organizer",
				externalId: "remote-dm-7",
				id: "inbox-organizer-dm",
				kind: "dm",
				permalink: "https://x.example/messages/7",
				platform: "x",
				read: false,
				socialAccountId: "account-x",
				text: "Could we talk about the release next week?",
			}),
			createItem({
				author: "@riley",
				externalId: "remote-mention-3",
				id: "inbox-riley-unsafe-link",
				kind: "mention",
				permalink: "javascript:alert(1)",
				platform: "bluesky",
				read: true,
				socialAccountId: "account-bluesky",
				text: "Thanks for the clear example in the post.",
			}),
			createItem({
				author: "@lena",
				externalId: "remote-reply-9",
				id: "inbox-lena-reply",
				kind: "reply",
				permalink: "https://instagram.example/posts/reply-9",
				platform: "instagram",
				read: false,
				socialAccountId: "account-instagram",
				text: "I tried the new workflow and it saved me time.",
			}),
		],
		platforms: [
			platformInfo("instagram", "Instagram"),
			platformInfo("x", "X"),
			platformInfo("bluesky", "Bluesky"),
		],
		requests: [],
	};
}

function installSocialFixture(page: Page): SocialFixture {
	const fixture = createSocialFixture();
	const failures: PendingFailure[] = [];
	fixture.failNext = (failure) => failures.push(failure);

	page.route("**/__social/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const pathWithoutQuery = url.pathname.slice("/__social".length);
		const pathWithQuery = `${pathWithoutQuery}${url.search}`;
		const rawBody = request.postData();
		const body = rawBody === null ? undefined : request.postDataJSON();
		const recorded: RecordedRequest = {
			...(body === undefined ? undefined : { body }),
			method,
			path: pathWithQuery,
			status: 0,
		};
		fixture.requests.push(recorded);

		const failureIndex = failures.findIndex(
			(failure) =>
				failure.method === method && failure.path === pathWithoutQuery
		);
		if (failureIndex !== -1) {
			const [failure] = failures.splice(failureIndex, 1);
			if (failure.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
			}
			recorded.status = failure.status;
			await route.fulfill({
				body: JSON.stringify({ error: failure.message }),
				contentType: "application/json",
				status: failure.status,
			});
			return;
		}

		if (method === "GET" && pathWithoutQuery === "/workspaces") {
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify({
					workspaces: [
						{
							created_at: Date.now() - 86_400_000,
							id: WORKSPACE_ID,
							name: "Inbox proof",
						},
					],
				}),
				contentType: "application/json",
			});
			return;
		}
		if (method === "GET" && pathWithoutQuery === "/accounts") {
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify({ accounts: fixture.accounts }),
				contentType: "application/json",
			});
			return;
		}
		if (method === "GET" && pathWithoutQuery === "/platforms") {
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify({ platforms: fixture.platforms }),
				contentType: "application/json",
			});
			return;
		}
		if (method === "GET" && pathWithoutQuery === "/inbox") {
			const kind = url.searchParams.get("kind");
			const unreadOnly = url.searchParams.get("unread") === "true";
			const limit = Math.min(
				500,
				Math.max(1, Number(url.searchParams.get("limit") ?? 200))
			);
			const inbox = fixture.items
				.filter((item) => !kind || item.kind === kind)
				.filter((item) => !(unreadOnly && item.read))
				.sort((left, right) => right.received_at - left.received_at)
				.slice(0, limit);
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify({ inbox }),
				contentType: "application/json",
			});
			return;
		}
		if (method === "POST" && pathWithoutQuery === "/inbox/refresh") {
			const refreshed = createItem({
				author: "@kira",
				externalId: "remote-refresh-1",
				id: "inbox-kira-refresh",
				kind: "mention",
				permalink: "https://social.example/posts/refresh-1",
				platform: "bluesky",
				read: false,
				socialAccountId: "account-bluesky",
				text: "A new mention arrived during this local refresh.",
			});
			if (!fixture.items.some((item) => item.id === refreshed.id)) {
				fixture.items.push(refreshed);
			}
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify({
					accounts_polled: 3,
					accounts_skipped: 0,
					errors: [],
					fetched: 1,
					new: 1,
				}),
				contentType: "application/json",
			});
			return;
		}

		const readMatch = pathWithoutQuery.match(/^\/inbox\/([^/]+)\/read$/);
		if (method === "POST" && readMatch) {
			const item = fixture.items.find(
				(candidate) => candidate.id === readMatch[1]
			);
			if (!item) {
				recorded.status = 404;
				await route.fulfill({
					body: JSON.stringify({ error: "Inbox item not found." }),
					contentType: "application/json",
					status: 404,
				});
				return;
			}
			item.read =
				z.object({ read: z.boolean() }).safeParse(body).data?.read ?? true;
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify(item),
				contentType: "application/json",
			});
			return;
		}

		const replyMatch = pathWithoutQuery.match(/^\/inbox\/([^/]+)\/reply$/);
		if (method === "POST" && replyMatch) {
			const item = fixture.items.find(
				(candidate) => candidate.id === replyMatch[1]
			);
			const text =
				z.object({ text: z.string() }).safeParse(body).data?.text ?? "";
			if (!(item && text.trim())) {
				recorded.status = item ? 400 : 404;
				await route.fulfill({
					body: JSON.stringify({
						error: item ? "A reply needs text." : "Inbox item not found.",
					}),
					contentType: "application/json",
					status: recorded.status,
				});
				return;
			}
			item.replied = true;
			item.read = true;
			recorded.status = 200;
			await route.fulfill({
				body: JSON.stringify(item),
				contentType: "application/json",
			});
			return;
		}

		recorded.status = 404;
		await route.fulfill({
			body: JSON.stringify({ error: "Unhandled local Social fixture route." }),
			contentType: "application/json",
			status: 404,
		});
	});

	return fixture;
}

async function mountInbox(page: Page): Promise<FrameLocator> {
	const appHtml = await readFile(SOCIAL_BUNDLE, "utf8");
	await page.goto("/social-inbox-proof.html");
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await page.waitForLoadState("networkidle");
	let mounted = false;
	for (let attempt = 0; attempt < 2 && !mounted; attempt += 1) {
		try {
			await page.evaluate((bundle) => {
				window.__socialInboxProof.mount(bundle);
			}, appHtml);
			mounted = true;
		} catch (error) {
			if (attempt > 0) {
				throw error;
			}
			if (!(error instanceof Error)) {
				throw error;
			}
			if (!error.message.includes("Execution context was destroyed")) {
				throw error;
			}
			await page.waitForLoadState("domcontentloaded");
			await expect(page.locator("body")).toHaveAttribute(
				"data-harness-ready",
				"1"
			);
			await page.waitForLoadState("networkidle");
		}
	}
	await expect
		.poll(() => page.evaluate(() => window.__socialInboxProof.connected()), {
			timeout: 20_000,
		})
		.toBe(true);
	const inbox = page.frameLocator('iframe[title="Social Inbox proof"]');
	await expect(inbox.getByRole("heading", { name: "Inbox" })).toBeVisible();
	return inbox;
}

async function inboxQueries(
	fixture: SocialFixture
): Promise<RecordedRequest[]> {
	return fixture.requests.filter(
		(request) => request.method === "GET" && request.path.startsWith("/inbox?")
	);
}

function rowFor(inbox: FrameLocator, author: string): Locator {
	return inbox.getByRole("button", { name: new RegExp(author) });
}

async function clickAndObserveDisabled(button: Locator): Promise<boolean> {
	const disabledWhilePending = button.evaluate(
		(element) =>
			new Promise<boolean>((resolve) => {
				const target =
					/* SAFETY: The only callers pass the actual mounted InboxPanel Refresh and Send native Button locators to this pending-state observer. Those authored controls use the default native button, whose disabled property is observed; no arbitrary Locator element is admitted. */ element as HTMLButtonElement;
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
				timer = window.setTimeout(() => finish(target.disabled), 1500);
			})
	);
	const click = button.click();
	const disabled = await disabledWhilePending;
	await click;
	return disabled;
}

async function saveEvidence(page: Page, filename: string): Promise<void> {
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIRECTORY, filename),
	});
}

const pageErrors = new WeakMap<Page, string[]>();

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
