import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	capabilitiesFromGrants,
	type HostServices,
	type NotificationRecord,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { Toaster, toast } from "@ryu/ui/components/sileo.tsx";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "../../../../packages/app-host/src/toast-host.ts";

const PLUGIN_ID = "@ryu/approvals";
const GRANTS = ["approvals:crud", "quests:crud", "ui:toast", "shell:integrate"];

interface Approval {
	created_at: string;
	decided_at?: string | null;
	id: string;
	kind: string;
	note?: string | null;
	risk_tags: string[];
	status: string;
	summary: string;
	title: string;
}

interface Quest {
	completed_at?: string | null;
	id: string;
	status: string;
	suggestion?: {
		confidence: number;
		reason: string;
		suggested_at: string;
	} | null;
	title: string;
}

interface Notification extends NotificationRecord {
	ack_required: boolean;
	acked: boolean;
	archived_at?: string | null;
	body?: string | null;
	created_at: string;
	id: string;
	level: string;
	read_at?: string | null;
	source_app_id?: string | null;
	title: string;
	user_id: string;
}

interface Proactive {
	body: string | null;
	confidence: number;
	created_at: number;
	disposition: "push_now" | "inbox_only";
	id: string;
	metadata: Record<string, string>;
	suggestion_type: string;
	title: string;
}

interface ProofCall {
	input: unknown;
	method: string;
}

interface Gate {
	promise: Promise<void>;
	release: () => void;
	started: boolean;
}

interface FixtureState {
	ackResult: boolean;
	approvals: Approval[];
	feedback: Array<{ kind: string; suggestion_type: string }>;
	notifications: Notification[];
	quests: Quest[];
	suggestions: Proactive[];
}

function now(): string {
	return new Date().toISOString();
}

function initialState(): FixtureState {
	const timestamp = now();
	return {
		ackResult: true,
		approvals: [
			{
				created_at: timestamp,
				id: "approval-send",
				kind: "tool_call",
				risk_tags: ["external_send", "requires_review"],
				status: "pending",
				summary: "Send the approved customer update to the selected recipient.",
				title: "Allow outbound message",
			},
			{
				created_at: timestamp,
				id: "approval-resume",
				kind: "workflow_gate",
				risk_tags: ["workflow"],
				status: "pending",
				summary: "Resume the paused release workflow.",
				title: "Resume workflow step",
			},
			{
				created_at: timestamp,
				decided_at: timestamp,
				id: "approval-old",
				kind: "heal_fix",
				risk_tags: [],
				status: "expired",
				summary: "This request expired before a decision.",
				title: "Previous expired request",
			},
		],
		feedback: [],
		notifications: [
			{
				ack_required: true,
				acked: false,
				archived_at: null,
				body: "A workflow is waiting for your confirmation.",
				created_at: timestamp,
				id: "notification-ack",
				level: "warning",
				read_at: null,
				source_app_id: "@ryu/workflows",
				title: "Workflow paused at review",
				user_id: "fixture-user",
			},
			{
				ack_required: false,
				acked: false,
				archived_at: null,
				body: "The deployment finished successfully.",
				created_at: timestamp,
				id: "notification-read",
				level: "success",
				read_at: timestamp,
				source_app_id: "@ryu/deployments",
				title: "Build completed",
				user_id: "fixture-user",
			},
			{
				ack_required: false,
				acked: false,
				archived_at: timestamp,
				body: "Kept for reference.",
				created_at: timestamp,
				id: "notification-archived",
				level: "info",
				read_at: timestamp,
				source_app_id: null,
				title: "Older archived notice",
				user_id: "fixture-user",
			},
			{
				ack_required: false,
				acked: false,
				archived_at: null,
				body: "An action needs attention.",
				created_at: timestamp,
				id: "notification-error",
				level: "error",
				read_at: null,
				source_app_id: "@ryu/deployments",
				title: "Action needed",
				user_id: "fixture-user",
			},
		],
		quests: [
			{
				id: "quest-complete",
				status: "open",
				suggestion: {
					confidence: 92,
					reason: "The requested release notes were added.",
					suggested_at: timestamp,
				},
				title: "Prepare release notes",
			},
			{
				id: "quest-snooze",
				status: "open",
				suggestion: {
					confidence: 76,
					reason: "The changelog was edited, but still needs review.",
					suggested_at: timestamp,
				},
				title: "Review changelog",
			},
		],
		suggestions: [
			{
				body: "  Review yesterday’s notes  ",
				confidence: 0.87,
				created_at: Math.floor(Date.now() / 1000),
				disposition: "inbox_only",
				id: "suggestion-chat",
				metadata: {},
				suggestion_type: "follow_up",
				title: "Review yesterday’s notes",
			},
			{
				body: "A short summary of the recent project activity.",
				confidence: 0.74,
				created_at: Math.floor(Date.now() / 1000),
				disposition: "push_now",
				id: "suggestion-dismiss",
				metadata: {},
				suggestion_type: "summary",
				title: "Catch up on project activity",
			},
		],
	};
}

let state = initialState();
const calls: ProofCall[] = [];
const failures = new Map<string, number>();
const gates = new Map<string, Gate>();
let connected = false;
let srcdoc = "";
let root: Root | null = null;
let toastHost = createScopedToastHost({
	renderer: createSileoToastRenderer(toast),
	sourceId: PLUGIN_ID,
});

function clone<T>(value: T): T {
	return structuredClone(value);
}

function record<Input>(method: string, input: Input): void {
	calls.push({ input: clone(input), method });
}

async function run<T, Input>(
	method: string,
	input: Input,
	operation: () => T
): Promise<T> {
	record(method, input);
	const failureCount = failures.get(method) ?? 0;
	if (failureCount > 0) {
		failures.set(method, failureCount - 1);
		throw new Error(`Fixture failure: ${method}`);
	}
	const gate = gates.get(method);
	if (gate) {
		gate.started = true;
		await gate.promise;
		gates.delete(method);
	}
	return clone(operation());
}

function findApproval(id: string): Approval {
	const approval = state.approvals.find((item) => item.id === id);
	if (approval?.status !== "pending") {
		throw new Error(`Approval ${id} is no longer pending`);
	}
	return approval;
}

function findNotification(id: string): Notification {
	const notification = state.notifications.find((item) => item.id === id);
	if (!notification) {
		throw new Error(`Notification ${id} was not found`);
	}
	return notification;
}

function findQuest(id: string): Quest {
	const quest = state.quests.find((item) => item.id === id);
	if (!quest) {
		throw new Error(`Quest ${id} was not found`);
	}
	return quest;
}

const services: HostServices = {
	approvalsList: () => run("approvals.list", null, () => state.approvals),
	approvalsApprove: ({ id, note }) =>
		run("approvals.approve", { id, note }, () => {
			const approval = findApproval(id);
			approval.status = "approved";
			approval.decided_at = now();
			approval.note = note ?? null;
			return approval;
		}),
	approvalsReject: ({ id, note }) =>
		run("approvals.reject", { id, note }, () => {
			const approval = findApproval(id);
			approval.status = "rejected";
			approval.decided_at = now();
			approval.note = note ?? null;
			return approval;
		}),
	notificationsList: () =>
		run("notifications.list", null, () => state.notifications),
	notificationsMarkRead: ({ id }) =>
		run("notifications.markRead", { id }, () => {
			findNotification(id).read_at ??= now();
		}),
	notificationsAck: ({ id }) =>
		run("notifications.ack", { id }, () => {
			findNotification(id).acked = true;
			return state.ackResult;
		}),
	notificationsArchive: ({ id }) =>
		run("notifications.archive", { id }, () => {
			const item = findNotification(id);
			item.archived_at ??= now();
			item.read_at ??= now();
		}),
	notificationsUnarchive: ({ id }) =>
		run("notifications.unarchive", { id }, () => {
			findNotification(id).archived_at = null;
		}),
	notificationsAppIcons: ({ appIds }) =>
		run("notifications.appIcons", { appIds }, () =>
			Object.fromEntries(
				appIds.map((id) => [
					id,
					{
						background: "#e0e7ff",
						glyph:
							"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Ccircle cx='5' cy='5' r='4' fill='%234f46e5'/%3E%3C/svg%3E",
						name: id === "@ryu/workflows" ? "Workflow Engine" : "Deployments",
					},
				])
			)
		),
	questsList: () => run("quests.list", null, () => state.quests),
	questsAcceptSuggestion: ({ id }) =>
		run("quests.acceptSuggestion", { id }, () => {
			const quest = findQuest(id);
			quest.status = "done";
			quest.completed_at = now();
			quest.suggestion = null;
			return quest;
		}),
	questsDismissSuggestion: ({ id }) =>
		run("quests.dismissSuggestion", { id }, () => {
			const quest = findQuest(id);
			quest.suggestion = null;
			return quest;
		}),
	suggestionsList: () => run("suggestions.list", null, () => state.suggestions),
	suggestionsFeedback: (input) =>
		run("suggestions.feedback", input, () => {
			state.feedback.push(input);
			return true;
		}),
	shellOpenTab: (input) => run("shell.openTab", input, () => undefined),
	shellThemeSubscribe: (_input, emit, signal) => {
		emit(
			JSON.stringify({
				"--background": "#ffffff",
				"--card": "#ffffff",
				"--foreground": "#111827",
			})
		);
		return new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	},
	uiToastDismiss: (input) => toastHost.dismiss(input),
	uiToastShow: (input) => toastHost.show(input),
	uiToastUpdate: (input) => toastHost.update(input),
};

interface MountOptions {
	failMethods?: string[];
}

interface ProofApi {
	blockNext(method: string): void;
	calls(): ProofCall[];
	clearCalls(): void;
	connected(): boolean;
	failNext(method: string): void;
	mount(options?: MountOptions): Promise<void>;
	release(method: string): void;
	snapshot(): FixtureState;
	waiting(method: string): boolean;
}

async function mount(options: MountOptions = {}): Promise<void> {
	state = initialState();
	calls.length = 0;
	failures.clear();
	gates.clear();
	for (const method of options.failMethods ?? []) {
		failures.set(method, (failures.get(method) ?? 0) + 1);
	}
	toastHost.dispose();
	toastHost = createScopedToastHost({
		renderer: createSileoToastRenderer(toast),
		sourceId: PLUGIN_ID,
	});
	connected = false;
	const response = await fetch("/__approvals_fixture");
	if (!response.ok) {
		throw new Error("The compiled Approvals companion fixture was not served.");
	}
	const appHtml = await response.text();
	const nonce = crypto.randomUUID();
	srcdoc = htmlCompanionSrcdoc(nonce, appHtml, PLUGIN_ID);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Approvals behavior proof host root missing");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(
			"div",
			{ style: { height: "100%", minHeight: 360 } },
			createElement(ExtensionHost, {
				srcdoc,
				nonce,
				granted: capabilitiesFromGrants(GRANTS),
				services,
				onConnected: () => {
					connected = true;
				},
				title: "Approvals behavior proof",
			}),
			createElement(Toaster, { position: "bottom-right" })
		)
	);
}

const api: ProofApi = {
	blockNext(method) {
		let release: Parameters<ConstructorParameters<typeof Promise<void>>[0]>[0] =
			() => undefined;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		gates.set(method, { promise, release, started: false });
	},
	clearCalls() {
		calls.length = 0;
	},
	calls() {
		return clone(calls);
	},
	connected() {
		return connected;
	},
	failNext(method) {
		failures.set(method, (failures.get(method) ?? 0) + 1);
	},
	mount,
	release(method) {
		gates.get(method)?.release();
	},
	snapshot() {
		return clone(state);
	},
	waiting(method) {
		return gates.get(method)?.started ?? false;
	},
};

declare global {
	interface Window {
		__approvalsProof: ProofApi;
	}
}

window.__approvalsProof = api;
document.body.setAttribute("data-harness-ready", "1");
