import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ApprovalRequest } from "../src/lib/api/approvals.ts";
import type { Quest } from "../src/lib/api/quests.ts";
import { parseProofJson } from "./fixture-json.ts";

const ORIGIN = "http://127.0.0.1:5468";
const PROOF_URL = `${ORIGIN}/inbox-center-interactions-proof.html`;
const USER_ID = "inbox-proof-user";
const NOW = new Date().toISOString();
const PREVIEW_LIMIT = 6;
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"e2e/evidence/inbox-center-interactions"
);

function minutesAgo(minutes: number): string {
	return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface FixtureState {
	announcements: ReturnType<typeof makeAnnouncement>[];
	approvals: ReturnType<typeof makeApproval>[];
	notifications: ReturnType<typeof makeNotification>[];
	quests: ReturnType<typeof makeQuest>[];
}

interface FixtureGate {
	promise: Promise<void>;
	release(): void;
	started: boolean;
}

interface InboxFixture {
	calls: ApiCall[];
	failNext(method: string, routePath: string, message: string): void;
	failures: Map<string, { count: number; message: string }>;
	gateNext(method: string, routePath: string): FixtureGate;
	gates: Map<string, FixtureGate>;
	state: FixtureState;
	unhandled: string[];
}

declare global {
	interface Window {
		__inboxCenterProof: {
			clearOpenedTabs(): void;
			externalUrls(): string[];
			openedTabs(): string[];
		};
	}
}

function makeApproval(
	id: string,
	title: string,
	riskTags: string[] = []
): ApprovalRequest {
	return {
		action: { type: "tool_call", tool_id: "deploy.release" },
		created_at: minutesAgo(2),
		id,
		kind: "tool_call",
		risk_tags: riskTags,
		status: "pending",
		summary: "Deploy the reviewed build to the canary environment.",
		title,
	};
}

function makeQuest(id: string, title: string): Quest {
	return {
		completion_condition: "The owner confirms this task is complete.",
		created_at: minutesAgo(10),
		id,
		kind: "task",
		status: "open",
		suggestion: {
			confidence: 0.94,
			reason: "The requested work appears in the recent activity.",
			suggested_at: minutesAgo(1),
		},
		title,
		updated_at: minutesAgo(1),
	};
}

function makeNotification(
	id: string,
	title: string,
	options: { archived?: boolean; level?: string; read?: boolean } = {}
) {
	return {
		ack_required: false,
		acked: false,
		archived_at: options.archived ? minutesAgo(5) : null,
		body: `Details for ${title}.`,
		created_at: minutesAgo(1),
		id,
		level: options.level ?? "info",
		read_at: options.read || options.archived ? minutesAgo(0.5) : null,
		source_app_id: null,
		title,
		user_id: USER_ID,
	};
}

function makeAnnouncement(id = "announcement-product-update") {
	return {
		blobColors: ["#182b4d", "#6b81ef"],
		body: "The Inbox now groups decisions, app notifications, and product updates.",
		color: "#5374df",
		createdAt: minutesAgo(5),
		icon: "sparkles",
		iconUrl: null,
		id,
		linkLabel: "Learn more",
		linkUrl: "https://ryu.example/updates/inbox",
		read: false,
		title: "A clearer Ryu Inbox",
		type: "card",
		visualCode: null,
		visualIcon: null,
		visualIconBackground: null,
		visualIconDither: null,
		visualIconUrl: null,
	};
}

function createInboxFixture(initial: Partial<FixtureState> = {}): InboxFixture {
	const state: FixtureState = {
		announcements: [],
		approvals: [],
		notifications: [],
		quests: [],
		...initial,
	};
	const calls: ApiCall[] = [];
	const failures = new Map<string, { count: number; message: string }>();
	const gates = new Map<string, FixtureGate>();
	const unhandled: string[] = [];
	return {
		calls,
		failures,
		gates,
		unhandled,
		state,
		failNext(method, routePath, message) {
			failures.set(`${method.toUpperCase()} ${routePath}`, {
				count: 1,
				message,
			});
		},
		gateNext(method, routePath) {
			let release = () => undefined;
			const promise = new Promise<void>((resolve) => {
				release = resolve;
			});
			const gate: FixtureGate = {
				started: false,
				promise,
				release,
			};
			gates.set(`${method.toUpperCase()} ${routePath}`, gate);
			return gate;
		},
	};
}

function parseBody(body: string | null) {
	if (!body) {
		return null;
	}
	try {
		return parseProofJson(body);
	} catch {
		return body;
	}
}

async function installApiFixture(page: Page, fixture: InboxFixture) {
	await page.route(`${ORIGIN}/api/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method().toUpperCase();
		const requestPath = url.pathname;
		const pathWithQuery = `${url.pathname}${url.search}`;
		const body = parseBody(request.postData());
		const key = `${method} ${requestPath}`;
		const respond = async <FixturePayload>(
			status: number,
			value: FixturePayload
		) => {
			await route.fulfill({
				body: JSON.stringify(value),
				contentType: "application/json",
				status,
			});
			fixture.calls.push({ body, method, path: pathWithQuery, status });
		};

		const gate = fixture.gates.get(key);
		if (gate) {
			gate.started = true;
			await gate.promise;
			fixture.gates.delete(key);
		}
		const plannedFailure = fixture.failures.get(key);
		if (plannedFailure && plannedFailure.count > 0) {
			plannedFailure.count -= 1;
			await respond(503, { error: plannedFailure.message });
			return;
		}

		if (method === "GET" && requestPath === "/api/auth/get-session") {
			await respond(200, {
				session: {
					createdAt: NOW,
					expiresAt: "2027-09-30T12:00:00.000Z",
					id: "inbox-proof-session",
					token: "inbox-proof-session-token",
					updatedAt: NOW,
					userId: USER_ID,
				},
				user: {
					createdAt: NOW,
					email: "inbox-proof@example.test",
					emailVerified: true,
					id: USER_ID,
					name: "Inbox Proof",
					updatedAt: NOW,
				},
			});
			return;
		}
		if (method === "GET" && requestPath === "/api/plugins") {
			await respond(200, { apps: [] });
			return;
		}
		if (method === "GET" && requestPath === "/api/approvals") {
			await respond(200, { approvals: fixture.state.approvals });
			return;
		}
		const approvalRoute = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/u.exec(
			requestPath
		);
		if (method === "POST" && approvalRoute) {
			const [, id, decision] = approvalRoute;
			const approval = fixture.state.approvals.find((item) => item.id === id);
			if (!approval) {
				await respond(404, { error: "Approval was not found." });
				return;
			}
			approval.status = decision === "approve" ? "approved" : "rejected";
			approval.decided_at = NOW;
			await respond(200, { approval });
			return;
		}
		if (method === "GET" && requestPath === "/api/quests") {
			await respond(200, { quests: fixture.state.quests });
			return;
		}
		const questRoute =
			/^\/api\/quests\/([^/]+)\/suggestion\/(accept|dismiss)$/u.exec(
				requestPath
			);
		if (method === "POST" && questRoute) {
			const [, id, decision] = questRoute;
			const quest = fixture.state.quests.find((item) => item.id === id);
			if (!quest) {
				await respond(404, { error: "Task suggestion was not found." });
				return;
			}
			quest.suggestion = null;
			if (decision === "accept") {
				quest.status = "done";
				quest.completed_at = NOW;
			}
			await respond(200, { quest });
			return;
		}
		if (method === "GET" && requestPath === "/api/notifications") {
			await respond(200, { notifications: fixture.state.notifications });
			return;
		}
		const notificationRoute =
			/^\/api\/notifications\/([^/]+)\/(read|archive|unarchive)$/u.exec(
				requestPath
			);
		if (method === "POST" && notificationRoute) {
			const [, id, action] = notificationRoute;
			const notification = fixture.state.notifications.find(
				(item) => item.id === id
			);
			if (!notification) {
				await respond(404, { error: "Notification was not found." });
				return;
			}
			if (action === "read") {
				notification.read_at ??= NOW;
			} else if (action === "archive") {
				notification.archived_at ??= NOW;
				notification.read_at ??= NOW;
			} else {
				notification.archived_at = null;
			}
			await respond(200, {});
			return;
		}
		if (method === "GET" && requestPath === "/api/announcements") {
			await respond(200, { announcements: fixture.state.announcements });
			return;
		}
		const announcementRoute =
			/^\/api\/announcements\/([^/]+)\/(read|dismiss)$/u.exec(requestPath);
		if (method === "POST" && announcementRoute) {
			const [, id, action] = announcementRoute;
			const announcement = fixture.state.announcements.find(
				(item) => item.id === id
			);
			if (!announcement) {
				await respond(404, { error: "Announcement was not found." });
				return;
			}
			if (action === "read") {
				announcement.read = true;
			} else {
				fixture.state.announcements = fixture.state.announcements.filter(
					(item) => item.id !== id
				);
			}
			await respond(200, {});
			return;
		}

		fixture.unhandled.push(`${method} ${pathWithQuery}`);
		await respond(501, {
			error: `Unhandled Inbox fixture route: ${method} ${pathWithQuery}`,
		});
	});
}

async function mountInbox(
	page: Page,
	fixture: InboxFixture,
	options: { announcements?: boolean; layout?: "split" | "unified" } = {}
) {
	await page.addInitScript(
		({ userId }) => {
			localStorage.setItem(
				"ryu_accounts",
				JSON.stringify([
					{
						email: "inbox-proof@example.test",
						image: null,
						name: "Inbox Proof",
						token: "inbox-proof-session-token",
						userId,
					},
				])
			);
			localStorage.setItem("ryu_active_user_id", userId);
			localStorage.setItem("ryu_session_token", "inbox-proof-session-token");
			localStorage.setItem(
				"ryu_oidc_user",
				JSON.stringify({
					email: "inbox-proof@example.test",
					name: "Inbox Proof",
				})
			);
		},
		{ userId: USER_ID }
	);
	await installApiFixture(page, fixture);
	const layout = options.layout ?? "split";
	const announcements = options.announcements === true;
	await page.goto(
		`${PROOF_URL}?layout=${layout}&announcements=${String(announcements)}`
	);
	await expect(page.locator("body")).toHaveAttribute(
		"data-harness-ready",
		"true"
	);
	const triggerLabel =
		layout === "unified" || announcements ? "Notifications" : "Inbox";
	const trigger = page.getByRole("button", { name: triggerLabel, exact: true });
	if (!announcements) {
		await expect(trigger).toBeVisible();
	}
	await expect
		.poll(
			() =>
				fixture.calls.some((call) => call.path === "/api/approvals") &&
				fixture.calls.some((call) => call.path === "/api/quests") &&
				fixture.calls.some((call) =>
					call.path.startsWith("/api/notifications?")
				) &&
				fixture.calls.some((call) => call.path === "/api/plugins")
		)
		.toBe(true);
	if (announcements) {
		await expect
			.poll(() =>
				fixture.calls.some((call) => call.path === "/api/announcements")
			)
			.toBe(true);
	}
	const pendingApprovalLabels = fixture.state.approvals
		.filter((item) => item.status === "pending")
		.map((item) => `Open ${String(item.title)} in the inbox`);
	const pendingQuestLabels = fixture.state.quests
		.filter((item) => item.status === "open" && item.suggestion)
		.map((item) => `Open ${String(item.title)} in the inbox`);
	const unreadNotificationLabels = fixture.state.notifications
		.filter((item) => !(item.read_at || item.archived_at))
		.slice(0, PREVIEW_LIMIT)
		.map((item) => `Open ${String(item.title)} in the inbox`);
	const requiredRowLabels =
		layout === "unified"
			? [
					...pendingApprovalLabels.slice(0, PREVIEW_LIMIT),
					...pendingQuestLabels.slice(0, PREVIEW_LIMIT),
					...(announcements ? [] : unreadNotificationLabels),
				].slice(0, 5)
			: [
					...pendingApprovalLabels,
					...pendingQuestLabels,
					...unreadNotificationLabels,
				];
	for (const label of requiredRowLabels) {
		await page.locator(`button[aria-label="${label}"]`).waitFor({
			state: "attached",
			timeout: 5000,
		});
	}
	return { trigger, layout };
}

function rowFor(page: Page, label: string) {
	return page
		.getByRole("button", { name: label, exact: true })
		.locator("xpath=..");
}

async function clearOpenedTabs(page: Page) {
	await page.evaluate(() => window.__inboxCenterProof.clearOpenedTabs());
}

async function openedTabs(page: Page): Promise<string[]> {
	return await page.evaluate(() => window.__inboxCenterProof.openedTabs());
}

async function capture(page: Page, filename: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.evaluate(async () => {
		const signature = () =>
			[
				...document.querySelectorAll(
					"[data-sidebar-overlay='open'], [data-testid='announcement-detail-dialog'], button"
				),
			]
				.map((element) => {
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					return [
						rect.x.toFixed(1),
						rect.y.toFixed(1),
						rect.width.toFixed(1),
						rect.height.toFixed(1),
						style.transform,
						style.opacity,
						style.clipPath,
					].join(":");
				})
				.join("|");
		let previous = "";
		let stableFrames = 0;
		for (let frame = 0; frame < 90 && stableFrames < 3; frame += 1) {
			await new Promise<void>((resolve) => {
				window.requestAnimationFrame(() => resolve());
			});
			const current = signature();
			stableFrames = current === previous ? stableFrames + 1 : 0;
			previous = current;
		}
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, filename),
	});
}

function assertNoUnhandledFixtureRoutes(fixture: InboxFixture) {
	expect(fixture.unhandled).toEqual([]);
}

test("split tray reads, archives, restores, filters, and opens the full Inbox", async ({
	page,
}) => {
	const notifications = [
		makeNotification("build-finished", "Build finished"),
		makeNotification("security-alert", "Security alert", { level: "warning" }),
		...Array.from({ length: 6 }, (_, index) =>
			makeNotification(`activity-${index + 1}`, `Project activity ${index + 1}`)
		),
		makeNotification("older-alert", "Previously archived alert", {
			archived: true,
			level: "error",
		}),
	];
	const fixture = createInboxFixture({ notifications });
	const { trigger } = await mountInbox(page, fixture);

	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("tab", { name: "Unread" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	const fullInboxMore = page.getByRole("button", {
		name: "2 more in the full inbox",
		exact: true,
	});
	await expect(fullInboxMore).toBeVisible();
	await expect(fullInboxMore).toBeInViewport();
	await capture(page, "inbox-center-split-notification-tray.png");
	await fullInboxMore.click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");

	await clearOpenedTabs(page);
	await trigger.click();
	const securityAlert = rowFor(page, "Open Security alert in the inbox");
	fixture.failNext(
		"POST",
		"/api/notifications/security-alert/archive",
		"Archive is temporarily unavailable."
	);
	await securityAlert
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect(
		page.getByText("/api/notifications/security-alert/archive failed: 503")
	).toBeVisible();
	await expect(securityAlert).toBeVisible();
	await securityAlert
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "security-alert")
					?.archived_at
		)
		.toBe(NOW);
	await expect(securityAlert).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "security-alert")
					?.read_at
		)
		.toBe(NOW);
	await capture(page, "inbox-center-split-archived-unread-filter.png");

	const archiveCalls = fixture.calls.filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/security-alert/archive"
	);
	expect(archiveCalls.map((call) => call.status)).toEqual([503, 200]);
	await page.getByRole("tab", { name: "Archived" }).click();
	const archivedSecurityAlert = rowFor(
		page,
		"Open Security alert in the inbox"
	);
	await expect(archivedSecurityAlert).toBeVisible();
	await archivedSecurityAlert
		.getByRole("button", { name: "Restore to inbox", exact: true })
		.click();
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "security-alert")
					?.archived_at
		)
		.toBeNull();
	await expect(archivedSecurityAlert).toHaveCount(0);
	const restoreCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/security-alert/unarchive"
	);
	expect(restoreCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/security-alert/unarchive",
		status: 200,
	});

	await page.getByRole("tab", { name: "All" }).click();
	await expect(rowFor(page, "Open Security alert in the inbox")).toBeVisible();
	await page.getByRole("tab", { name: "Warning" }).click();
	await expect(rowFor(page, "Open Security alert in the inbox")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Open Build finished in the inbox" })
	).toHaveCount(0);
	await page.getByRole("tab", { name: "All" }).click();
	await page
		.getByRole("button", { name: "Open Build finished in the inbox" })
		.click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "build-finished")
					?.read_at
		)
		.toBe(NOW);
	const readCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/build-finished/read"
	);
	expect(readCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/build-finished/read",
		status: 200,
	});
	await expect(trigger).toHaveAttribute("aria-expanded", "false");

	await clearOpenedTabs(page);
	await trigger.click();
	await page.getByRole("tab", { name: "Unread" }).click();
	await expect(
		page.getByRole("button", { name: "Open Build finished in the inbox" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Open inbox", exact: true }).click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	assertNoUnhandledFixtureRoutes(fixture);
});

test("split approval and task actions send exact decisions, expose pending state, and recover after errors", async ({
	page,
}) => {
	const fixture = createInboxFixture({
		approvals: [
			makeApproval("approval-approve", "Approve nightly deploy"),
			makeApproval("approval-reject", "Reject credential export", [
				"credential_access",
			]),
		],
		quests: [
			makeQuest("quest-done", "Prepare release notes"),
			makeQuest("quest-dismiss", "Review changelog"),
		],
	});
	const { trigger } = await mountInbox(page, fixture);
	await trigger.click();

	const approveGate = fixture.gateNext(
		"POST",
		"/api/approvals/approval-approve/approve"
	);
	const approveRow = rowFor(page, "Open Approve nightly deploy in the inbox");
	await approveRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	await expect.poll(() => approveGate.started).toBe(true);
	await expect(
		approveRow.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	await expect(
		approveRow.getByRole("button", { name: "Reject", exact: true })
	).toHaveCount(0);
	await capture(page, "inbox-center-split-approval-pending.png");
	approveGate.release();
	await expect(approveRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.approvals.find((item) => item.id === "approval-approve")
					?.status
		)
		.toBe("approved");
	expect(
		fixture.calls.find(
			(call) => call.path === "/api/approvals/approval-approve/approve"
		)
	).toEqual({
		body: {},
		method: "POST",
		path: "/api/approvals/approval-approve/approve",
		status: 200,
	});

	fixture.failNext(
		"POST",
		"/api/approvals/approval-reject/reject",
		"Approval fixture denied the request."
	);
	const rejectRow = rowFor(page, "Open Reject credential export in the inbox");
	await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(
		page.getByText("/api/approvals/approval-reject/reject failed: 503")
	).toBeVisible();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(rejectRow).toBeVisible();
	await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(rejectRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.approvals.find((item) => item.id === "approval-reject")
					?.status
		)
		.toBe("rejected");
	const rejectCalls = fixture.calls.filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/approvals/approval-reject/reject"
	);
	expect(rejectCalls).toEqual([
		{
			body: {},
			method: "POST",
			path: "/api/approvals/approval-reject/reject",
			status: 503,
		},
		{
			body: {},
			method: "POST",
			path: "/api/approvals/approval-reject/reject",
			status: 200,
		},
	]);

	const doneRow = rowFor(page, "Open Prepare release notes in the inbox");
	await doneRow.getByRole("button", { name: "Done", exact: true }).click();
	await expect(doneRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.quests.find((item) => item.id === "quest-done")?.status
		)
		.toBe("done");
	expect(
		fixture.calls.find(
			(call) => call.path === "/api/quests/quest-done/suggestion/accept"
		)
	).toEqual({
		body: null,
		method: "POST",
		path: "/api/quests/quest-done/suggestion/accept",
		status: 200,
	});

	fixture.failNext(
		"POST",
		"/api/quests/quest-dismiss/suggestion/dismiss",
		"Task suggestion fixture denied the request."
	);
	const dismissRow = rowFor(page, "Open Review changelog in the inbox");
	await dismissRow
		.getByRole("button", { name: "Not yet", exact: true })
		.click();
	await expect(
		page.getByText("/api/quests/quest-dismiss/suggestion/dismiss failed: 503")
	).toBeVisible();
	await expect(dismissRow).toBeVisible();
	await dismissRow
		.getByRole("button", { name: "Not yet", exact: true })
		.click();
	await expect(dismissRow).toHaveCount(0);
	const dismissCalls = fixture.calls.filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/quests/quest-dismiss/suggestion/dismiss"
	);
	expect(dismissCalls.map((call) => call.status)).toEqual([503, 200]);
	assertNoUnhandledFixtureRoutes(fixture);
});

test("unified stack decisions keep the right actions disabled, filter rows, and route into the Inbox", async ({
	page,
}) => {
	const fixture = createInboxFixture({
		approvals: [
			makeApproval("unified-approve", "Approve production rollout"),
			makeApproval("unified-reject", "Reject external transfer"),
		],
		notifications: [
			makeNotification("unified-release", "Unified release ready"),
			makeNotification("unified-warning", "Unified warning", {
				level: "warning",
			}),
			makeNotification("unified-archived", "Unified archived note", {
				archived: true,
			}),
		],
		quests: [
			makeQuest("unified-done", "Write deployment notes"),
			makeQuest("unified-dismiss", "Check dashboard alerts"),
		],
	});
	const { trigger } = await mountInbox(page, fixture, { layout: "unified" });
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(trigger).toBeFocused();
	await trigger.click();
	await capture(page, "inbox-center-unified-stack-open.png");

	const approveGate = fixture.gateNext(
		"POST",
		"/api/approvals/unified-approve/approve"
	);
	const approveRow = rowFor(
		page,
		"Open Approve production rollout in the inbox"
	);
	await approveRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	await expect.poll(() => approveGate.started).toBe(true);
	await expect(
		approveRow.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	await expect(
		approveRow.getByRole("button", { name: "Reject", exact: true })
	).toHaveCount(0);
	await expect(
		approveRow.getByRole("status", { name: "Approval decision pending" })
	).toBeVisible();
	await capture(page, "inbox-center-unified-approval-disabled.png");
	approveGate.release();
	await expect(approveRow).toHaveCount(0);

	const rejectRow = rowFor(page, "Open Reject external transfer in the inbox");
	await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(rejectRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.approvals.find((item) => item.id === "unified-reject")
					?.status
		)
		.toBe("rejected");

	const doneGate = fixture.gateNext(
		"POST",
		"/api/quests/unified-done/suggestion/accept"
	);
	const doneRow = rowFor(page, "Open Write deployment notes in the inbox");
	await doneRow.getByRole("button", { name: "Done", exact: true }).click();
	await expect.poll(() => doneGate.started).toBe(true);
	await expect(
		doneRow.getByRole("button", { name: "Done", exact: true })
	).toHaveCount(0);
	await expect(
		doneRow.getByRole("button", { name: "Not yet", exact: true })
	).toHaveCount(0);
	await expect(
		doneRow.getByRole("status", { name: "Task suggestion decision pending" })
	).toBeVisible();
	doneGate.release();
	await expect(doneRow).toHaveCount(0);

	const dismissRow = rowFor(page, "Open Check dashboard alerts in the inbox");
	await dismissRow
		.getByRole("button", { name: "Not yet", exact: true })
		.click();
	await expect(dismissRow).toHaveCount(0);

	await page.getByRole("tab", { name: "Archived" }).click();
	const archivedNotice = rowFor(
		page,
		"Open Unified archived note in the inbox"
	);
	await expect(archivedNotice).toBeVisible();
	await expect(
		rowFor(page, "Open Unified release ready in the inbox")
	).toHaveCount(0);
	await capture(page, "inbox-center-unified-archived-filter.png");
	await page.getByRole("tab", { name: "Warning" }).click();
	await expect(rowFor(page, "Open Unified warning in the inbox")).toBeVisible();
	await expect(
		rowFor(page, "Open Unified release ready in the inbox")
	).toHaveCount(0);
	await page.getByRole("tab", { name: "Unread" }).click();
	const releaseNotice = rowFor(page, "Open Unified release ready in the inbox");
	await releaseNotice
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect(releaseNotice).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find(
					(item) => item.id === "unified-release"
				)?.archived_at
		)
		.toBe(NOW);
	const archiveCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/unified-release/archive"
	);
	expect(archiveCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/unified-release/archive",
		status: 200,
	});
	await page.getByRole("tab", { name: "Archived" }).click();
	const archivedReleaseNotice = rowFor(
		page,
		"Open Unified release ready in the inbox"
	);
	await archivedReleaseNotice
		.getByRole("button", { name: "Restore to inbox", exact: true })
		.click();
	await expect(archivedReleaseNotice).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find(
					(item) => item.id === "unified-release"
				)?.archived_at
		)
		.toBeNull();
	const restoreCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/unified-release/unarchive"
	);
	expect(restoreCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/unified-release/unarchive",
		status: 200,
	});
	await page.getByRole("tab", { name: "All" }).click();
	await expect(
		rowFor(page, "Open Unified release ready in the inbox")
	).toBeVisible();
	await page
		.getByRole("button", { name: /notifications\. Open inbox\./u })
		.click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	assertNoUnhandledFixtureRoutes(fixture);
});

for (const layout of ["split", "unified"] as const) {
	test(`${layout} announcement detail loads, marks read, reopens, and closes`, async ({
		page,
	}) => {
		const announcement = makeAnnouncement();
		const fixture = createInboxFixture({ announcements: [announcement] });
		const { trigger } = await mountInbox(page, fixture, {
			announcements: true,
			layout,
		});
		const detail = page.getByTestId("announcement-detail-dialog");
		await expect(detail).toBeVisible();
		await expect(
			detail.getByRole("heading", { name: "A clearer Ryu Inbox" })
		).toBeVisible();
		await expect(detail).toContainText(
			"The Inbox now groups decisions, app notifications, and product updates."
		);
		await expect
			.poll(
				() =>
					fixture.state.announcements.find(
						(item) => item.id === announcement.id
					)?.read
			)
			.toBe(true);
		const readCall = fixture.calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/api/announcements/${announcement.id}/read`
		);
		expect(readCall).toEqual({
			body: null,
			method: "POST",
			path: `/api/announcements/${announcement.id}/read`,
			status: 200,
		});
		await capture(page, `inbox-center-${layout}-announcement-detail.png`);

		await detail.getByRole("button", { name: "Done", exact: true }).click();
		await expect(detail).toBeHidden();
		await trigger.click();
		await page.getByRole("tab", { name: "All" }).click();
		const announcementRow = page.getByRole("button", {
			name: "Open A clearer Ryu Inbox",
			exact: true,
		});
		await announcementRow.click();
		await expect(detail).toBeVisible();
		await detail
			.getByRole("button", { name: "Learn more", exact: true })
			.click();
		await expect(detail).toBeHidden();
		expect(
			await page.evaluate(() => window.__inboxCenterProof.externalUrls())
		).toEqual(["https://ryu.example/updates/inbox"]);
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
		await trigger.click();
		await page.getByRole("tab", { name: "All" }).click();
		const dismissButton = page.getByRole("button", {
			name: "Dismiss announcement",
			exact: true,
		});
		await dismissButton.click();
		await expect
			.poll(() =>
				fixture.state.announcements.some((item) => item.id === announcement.id)
			)
			.toBe(false);
		await expect
			.poll(() =>
				fixture.calls.some(
					(call) =>
						call.method === "POST" &&
						call.path === `/api/announcements/${announcement.id}/dismiss`
				)
			)
			.toBe(true);
		const dismissCall = fixture.calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/api/announcements/${announcement.id}/dismiss`
		);
		expect(dismissCall).toEqual({
			body: null,
			method: "POST",
			path: `/api/announcements/${announcement.id}/dismiss`,
			status: 200,
		});
		assertNoUnhandledFixtureRoutes(fixture);
	});
}
