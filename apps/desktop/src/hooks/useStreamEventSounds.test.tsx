// The shell's stream hooks play a UI cue next to their toast. These pin which
// cue each event plays, that it is tagged as a stream cue (so only the main
// window sounds it), and that the approval cue keeps the toast's Online gate.

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type EventCallback = (event: unknown) => void;

function createStreamMock() {
	const callbacks: EventCallback[] = [];
	const stream = mock(
		(
			_target: unknown,
			onEvent: EventCallback,
			_signal?: AbortSignal,
			_onResync?: () => void
		) => {
			callbacks.push(onEvent);
			return Promise.resolve();
		}
	);
	return {
		emit: (event: unknown) => {
			const latest = callbacks.at(-1);
			if (!latest) {
				throw new Error("The hook never subscribed");
			}
			act(() => latest(event));
		},
		stream,
	};
}

const approvals = createStreamMock();
const quests = createStreamMock();
const monitors = createStreamMock();
const desktopNotifications = createStreamMock();

mock.module("@/src/lib/api/approvals.ts", () => ({
	streamApprovalEvents: approvals.stream,
}));
mock.module("@/src/lib/api/quests.ts", () => ({
	streamQuestEvents: quests.stream,
}));
mock.module("@/src/lib/api/monitors.ts", () => ({
	streamMonitorAlerts: monitors.stream,
}));
mock.module("@/src/lib/api/events.ts", () => ({
	streamDesktopNotifications: desktopNotifications.stream,
}));
mock.module("@/src/lib/notifications/os-notify.ts", () => ({
	resolveNotificationSender: () => Promise.resolve(null),
	showOsNotification: () => Promise.resolve(),
}));
const toast = { error: mock(), info: mock(), success: mock() };
mock.module("@ryu/ui/components/sileo.tsx", () => ({ toast }));
mock.module("@ryu/ui/components/sileo", () => ({ toast }));

const node = { token: "node-token", url: "https://node.example" };
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));

const { __setSoundSinkForTests } = await import(
	"@/src/lib/sounds/play-sound.ts"
);
const { setUserAvailabilityStatus } = await import(
	"@/src/lib/user-availability.ts"
);
const { useApprovalEvents } = await import("./useApprovalEvents.ts");
const { useQuestEvents } = await import("./useQuestEvents.ts");
const { useMonitorAlertsStream } = await import("./useMonitorAlertsStream.ts");
const { useDesktopNotificationsStream } = await import(
	"./useDesktopNotificationsStream.ts"
);

interface Cue {
	id: string;
	key?: string;
	source?: string;
}
const cues: Cue[] = [];

function Harness() {
	useApprovalEvents();
	useQuestEvents();
	useMonitorAlertsStream();
	useDesktopNotificationsStream();
	return null;
}

const container = document.createElement("div");
let root: Root;

function setStatus(status: "online" | "away" | "do-not-disturb") {
	act(() => setUserAvailabilityStatus(status));
}

beforeAll(async () => {
	__setSoundSinkForTests((id, options) => {
		cues.push({ id, key: options.key, source: options.source });
	});
	root = createRoot(container);
	await act(async () => {
		root.render(
			<QueryClientProvider client={new QueryClient()}>
				<Harness />
			</QueryClientProvider>
		);
		await Promise.resolve();
	});
});

beforeEach(() => {
	setStatus("online");
	cues.length = 0;
});

afterAll(() => {
	act(() => root.unmount());
	__setSoundSinkForTests(null);
});

function approvalEvent(type: "created" | "decided", id: string) {
	return {
		type,
		request: {
			created_at: "2026-10-31T00:00:00Z",
			id,
			kind: "tool_call",
			risk_tags: [],
			status: "pending",
			summary: "Run a shell command",
			title: "Shell",
		},
	};
}

function quest(id: string) {
	return { id, title: `Quest ${id}` };
}

describe("approval stream sounds", () => {
	test("a created request knocks once, keyed by request id, while Online", () => {
		approvals.emit(approvalEvent("created", "req-1"));
		approvals.emit(approvalEvent("decided", "req-1"));
		expect(cues).toEqual([
			{ id: "approval-needed", key: "approval:req-1", source: "stream" },
		]);
	});

	test("Away and Do not disturb stay silent, like the toast", () => {
		for (const status of ["away", "do-not-disturb"] as const) {
			setStatus(status);
			approvals.emit(approvalEvent("created", `req-${status}`));
		}
		expect(cues).toEqual([]);
	});
});

describe("quest stream sounds", () => {
	test("suggestions, auto-completions and manual completions each cue", () => {
		quests.emit({
			type: "suggested",
			quest: quest("q1"),
			confidence: 90,
			reason: "Saw the PR merge",
		});
		quests.emit({ type: "completed", quest: quest("q1"), auto: true });
		quests.emit({ type: "completed", quest: quest("q2"), auto: false });
		quests.emit({ type: "updated", quest: quest("q3") });
		expect(cues).toEqual([
			{ id: "quest-suggest", key: "quest-suggest:q1", source: "stream" },
			{ id: "quest-complete", key: "quest:q1", source: "stream" },
			{ id: "quest-complete", key: "quest:q2", source: "stream" },
		]);
	});
});

describe("alert and notification stream sounds", () => {
	test("a monitor alert plays the alert cue", () => {
		monitors.emit({
			monitor_id: 1,
			monitor_name: "Disk",
			title: "Disk almost full",
			message: "92% used",
		});
		expect(cues).toEqual([{ id: "alert", key: undefined, source: "stream" }]);
	});

	test("desktop notifications pick the cue from their level", () => {
		desktopNotifications.emit({ title: "Done", level: "success" });
		desktopNotifications.emit({ title: "Heads up", level: "warning" });
		desktopNotifications.emit({ title: "Broke", level: "error" });
		desktopNotifications.emit({ title: "Plain" });
		expect(cues.map((cue) => [cue.id, cue.source])).toEqual([
			["message", "stream"],
			["alert", "stream"],
			["alert", "stream"],
			["message", "stream"],
		]);
	});
});
