import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	expect,
	type FrameLocator,
	type Locator,
	type Page,
} from "@playwright/test";
import { z } from "zod";
import type {
	InboxItem,
	Platform,
	PlatformInfo,
	SocialAccount,
} from "../../../apps-store/social/ui/src/types.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for social-inbox-proof.spec.ts, kept apart so each file stays under the token limit.

declare const window: Window;

export const WORKSPACE_ID = "ws-inbox-proof";
export const SOCIAL_BUNDLE = path.join(
	tmpdir(),
	"ryu-social-inbox-build/index.html"
);
export const EXTERNAL_POST_URL = "https://social.example/posts/original-42";
export const EVIDENCE_DIRECTORY = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface RecordedRequest {
	body?: unknown;
	method: string;
	path: string;
	status: number;
}

export interface PendingFailure {
	delayMs?: number;
	message: string;
	method: string;
	path: string;
	status: number;
}

export interface SocialFixture {
	accounts: SocialAccount[];
	failNext: (failure: PendingFailure) => void;
	items: InboxItem[];
	platforms: PlatformInfo[];
	requests: RecordedRequest[];
}

export type SocialInboxProofWindow = Window;

export function platformInfo(platform: Platform, label: string): PlatformInfo {
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

export function createItem(input: {
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

export function createSocialFixture(): SocialFixture {
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

export function installSocialFixture(page: Page): SocialFixture {
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

export async function mountInbox(page: Page): Promise<FrameLocator> {
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

export async function inboxQueries(
	fixture: SocialFixture
): Promise<RecordedRequest[]> {
	return fixture.requests.filter(
		(request) => request.method === "GET" && request.path.startsWith("/inbox?")
	);
}

export function rowFor(inbox: FrameLocator, author: string): Locator {
	return inbox.getByRole("button", { name: new RegExp(author) });
}

export async function clickAndObserveDisabled(
	button: Locator
): Promise<boolean> {
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

export async function saveEvidence(
	page: Page,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIRECTORY, filename),
	});
}

export const pageErrors = new WeakMap<Page, string[]>();
