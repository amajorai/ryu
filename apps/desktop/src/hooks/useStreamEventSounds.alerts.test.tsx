// The per-user notification, meeting and credit-alert streams each play a UI
// cue beside their toast. These pin the cue each event plays and that it is a
// stream cue (so only the main window sounds it), and that a user
// notification picks `alert` for warnings and errors and `message` otherwise.

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

/** Latest subscriber per stream, filled when each hook connects. */
const subscribers = {
	notifications: null as EventCallback | null,
	meetings: null as EventCallback | null,
};

function emit(stream: keyof typeof subscribers, event: unknown): void {
	const callback = subscribers[stream];
	if (!callback) {
		throw new Error(`${stream} never subscribed`);
	}
	act(() => callback(event));
}

const never = (signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		signal?.addEventListener("abort", () => resolve());
	});

mock.module("@/src/lib/api/notifications.ts", () => ({
	redactConnectSuggestionEvent: (event: unknown) => event,
	streamUserNotifications: (
		_target: unknown,
		_userId: string,
		onEvent: EventCallback,
		signal?: AbortSignal
	) => {
		subscribers.notifications = onEvent;
		return never(signal);
	},
}));
mock.module("@/src/lib/api/meetings.ts", () => ({
	listMeetings: () => Promise.resolve([]),
	streamMeetingEvents: (
		_target: unknown,
		onEvent: EventCallback,
		signal?: AbortSignal
	) => {
		subscribers.meetings = onEvent;
		return never(signal);
	},
}));

/** Releases the next credit alert from the fake stream. */
let pushCredit: ((data: { title: string }) => void) | null = null;
mock.module("@/src/lib/api/credits.ts", () => ({
	hasCreditsAuth: () => true,
	isTerminalCreditsError: () => false,
	async *openCreditAlertStream(signal: AbortSignal) {
		while (!signal.aborted) {
			const data = await new Promise<{ title: string } | null>((resolve) => {
				pushCredit = resolve;
				signal.addEventListener("abort", () => resolve(null));
			});
			if (!data) {
				return;
			}
			yield { data };
		}
	},
}));
mock.module("@/src/lib/notifications/os-notify.ts", () => ({
	resolveNotificationSender: () => Promise.resolve(null),
	showOsNotification: () => Promise.resolve(),
}));
mock.module("@/lib/auth-client.ts", () => ({
	getActiveUserId: () => "user-1",
	useSession: () => ({ data: { user: { id: "user-1" } } }),
}));
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useTabsContext: () => ({ openTab: () => undefined }),
}));
mock.module("@/src/contributions/use-companion-alias.ts", () => ({
	useCompanionAlias: () => null,
}));
mock.module("@/src/lib/gating/useEnabledApps.ts", () => ({
	useEnabledApps: () => new Set(["@ryu/meetings"]),
}));
mock.module("@ryu/i18n/react", () => ({
	useLiteralMessages: () => (template: string) => template,
}));
const toast = {
	error: mock(),
	info: mock(),
	success: mock(),
	warning: mock(),
};
mock.module("@ryu/ui/components/sileo.tsx", () => ({ toast }));
mock.module("@ryu/ui/components/sileo", () => ({ toast }));

const node = { token: "node-token", url: "https://node.example" };
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));

const { __setSoundSinkForTests } = await import(
	"@/src/lib/sounds/play-sound.ts"
);
const { useNotificationEvents } = await import("./useNotificationEvents.ts");
const { useMeetingStream } = await import("./useMeetingStream.ts");
const { useCreditAlertEvents } = await import("./useCreditAlertEvents.ts");

interface Cue {
	id: string;
	key?: string;
	source?: string;
}
const cues: Cue[] = [];

function Harness() {
	useNotificationEvents();
	useMeetingStream();
	useCreditAlertEvents();
	return null;
}

const container = document.createElement("div");
let root: Root;

/** Let the stream loops reach their subscribe call. */
async function flush(): Promise<void> {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await Promise.resolve();
		}
	});
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
	await flush();
});

beforeEach(() => {
	cues.length = 0;
});

afterAll(() => {
	act(() => root.unmount());
	__setSoundSinkForTests(null);
});

describe("user notification sounds", () => {
	test("warnings and errors play alert; other levels play message", () => {
		emit("notifications", { title: "Saved", level: "info" });
		emit("notifications", { title: "Careful", level: "warning" });
		emit("notifications", { title: "Broke", level: "error" });
		emit("notifications", { title: "Plain" });
		expect(cues).toEqual([
			{ id: "message", key: undefined, source: "stream" },
			{ id: "alert", key: undefined, source: "stream" },
			{ id: "alert", key: undefined, source: "stream" },
			{ id: "message", key: undefined, source: "stream" },
		]);
	});
});

describe("meeting stream sounds", () => {
	test("a detected meeting cues; transcript and status frames do not", () => {
		emit("meetings", { type: "detected", title: "Standup" });
		emit("meetings", { type: "status", meeting_id: "m1" });
		emit("meetings", {
			type: "segment",
			segment: { meeting_id: "m1", text: "hello" },
		});
		expect(cues).toEqual([
			{ id: "meeting-detected", key: undefined, source: "stream" },
		]);
	});
});

describe("credit alert sounds", () => {
	test("each claimed credit alert plays the credit cue", async () => {
		await flush();
		expect(pushCredit).not.toBeNull();
		pushCredit?.({ title: "Credits below $5" });
		await flush();
		expect(cues).toEqual([
			{ id: "credit-alert", key: undefined, source: "stream" },
		]);
		expect(toast.warning).toHaveBeenCalledTimes(1);
	});
});
