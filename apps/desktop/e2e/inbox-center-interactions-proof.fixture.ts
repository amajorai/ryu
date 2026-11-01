// API fixture, record builders and page helpers shared by
// inbox-center-interactions-proof.spec.ts: the strict /api ledger with
// fail-next and gate-next controls, the proof mount, and evidence capture.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { ApprovalRequest } from "../src/lib/api/approvals.ts";
import type { Quest } from "../src/lib/api/quests.ts";
import { parseProofJson } from "./fixture-json.ts";

const ORIGIN = "http://127.0.0.1:5468";
const PROOF_URL = `${ORIGIN}/inbox-center-interactions-proof.html`;
const USER_ID = "inbox-proof-user";
export const NOW = new Date().toISOString();
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

export function makeApproval(
	id: string,
	title: string,
	riskTags: string[] = []
): ApprovalRequest {
	return {
		// A complete tool_call action: the approvals contract requires the
		// arguments, profile ids and configure flag Core always sends.
		action: {
			arguments: {},
			configure_approved: false,
			profile_ids: [],
			tool_id: "deploy.release",
			type: "tool_call",
		},
		created_at: minutesAgo(2),
		id,
		kind: "tool_call",
		risk_tags: riskTags,
		status: "pending",
		summary: "Deploy the reviewed build to the canary environment.",
		title,
	};
}

export function makeQuest(id: string, title: string): Quest {
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

export function makeNotification(
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

export function makeAnnouncement(id = "announcement-product-update") {
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

export function createInboxFixture(
	initial: Partial<FixtureState> = {}
): InboxFixture {
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

export async function mountInbox(
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
				// The approvals list asks for app jobs too (approvalsListPath).
				fixture.calls.some(
					(call) => call.path === "/api/approvals?include=app_jobs"
				) &&
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

export function rowFor(page: Page, label: string) {
	return page
		.getByRole("button", { name: label, exact: true })
		.locator("xpath=..");
}

export async function clearOpenedTabs(page: Page) {
	await page.evaluate(() => window.__inboxCenterProof.clearOpenedTabs());
}

export async function openedTabs(page: Page): Promise<string[]> {
	return await page.evaluate(() => window.__inboxCenterProof.openedTabs());
}

export async function capture(page: Page, filename: string) {
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

export function assertNoUnhandledFixtureRoutes(fixture: InboxFixture) {
	expect(fixture.unhandled).toEqual([]);
}
