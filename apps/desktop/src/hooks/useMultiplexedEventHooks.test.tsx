import { describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function createStreamMock() {
	const signals: AbortSignal[] = [];
	const stream = mock(
		async (
			_target: Parameters<
				typeof import("@/src/lib/api/approvals.ts").streamApprovalEvents
			>[0],
			_onEvent:
				| Parameters<
						typeof import("@/src/lib/api/approvals.ts").streamApprovalEvents
				  >[1]
				| Parameters<
						typeof import("@/src/lib/api/downloads.ts").streamDownloads
				  >[1]
				| Parameters<
						typeof import("@/src/lib/api/quests.ts").streamQuestEvents
				  >[1]
				| Parameters<
						typeof import("@/src/lib/api/monitors.ts").streamMonitorAlerts
				  >[1]
				| Parameters<
						typeof import("@/src/lib/api/events.ts").streamDesktopNotifications
				  >[1],
			signal?: AbortSignal,
			_onResync?: () => void
		) => {
			if (!signal) {
				throw new Error("Expected the hook to own an abort signal");
			}
			signals.push(signal);
		}
	);
	return { signals, stream };
}

const approval = createStreamMock();
const downloads = createStreamMock();
const quests = createStreamMock();
const monitors = createStreamMock();
const desktopNotifications = createStreamMock();

mock.module("@/src/lib/api/approvals.ts", () => ({
	streamApprovalEvents: approval.stream,
}));
mock.module("@/src/lib/api/downloads.ts", () => ({
	streamDownloads: downloads.stream,
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

// A real client rather than a partial react-query mock: the hooks' shared node
// helpers load modules that need the rest of the library. Its invalidation is
// spied on so resync refetches can be asserted.
const queryClient = new QueryClient();
const invalidateQueries = spyOn(queryClient, "invalidateQueries");
const toast = {
	error: mock(),
	info: mock(),
	success: mock(),
};
mock.module("@ryu/ui/components/sileo", () => ({ toast }));

const node = { token: "node-token", url: "https://node.example" };
mock.module("./useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));

const downloadState = {
	applySnapshot: mock(),
	applyUpdate: mock(),
	removeTask: mock(),
	reset: mock(),
};
function useDownloadsStoreMock<T>(
	selector: (state: typeof downloadState) => T
): T {
	return selector(downloadState);
}
mock.module("@/src/store/useDownloadsStore.ts", () => ({
	useDownloadsStore: useDownloadsStoreMock,
}));

const nodeState = { getActiveNode: () => node };
function useNodeStoreMock<T>(selector: (state: typeof nodeState) => T): T {
	return selector(nodeState);
}
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: useNodeStoreMock,
}));

const installState = { reset: mock() };
mock.module("@/src/store/useInstallStore.ts", () => ({
	useInstallStore: { getState: () => installState },
}));

const { useApprovalEvents } = await import("./useApprovalEvents.ts");
const { useDownloadsStream } = await import("./useDownloadsStream.ts");
const { useQuestEvents } = await import("./useQuestEvents.ts");
const { useMonitorAlertsStream } = await import("./useMonitorAlertsStream.ts");
const { useDesktopNotificationsStream } = await import(
	"./useDesktopNotificationsStream.ts"
);

function Harness() {
	useApprovalEvents();
	useDownloadsStream();
	useQuestEvents();
	useMonitorAlertsStream();
	useDesktopNotificationsStream();
	return null;
}

const streams = [approval, downloads, quests, monitors, desktopNotifications];

describe("multiplexed event hook lifecycle", () => {
	test("subscribes once per mount and aborts every subscription on cleanup", async () => {
		const container = document.createElement("div");
		const root = createRoot(container);

		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<Harness />
				</QueryClientProvider>
			);
			await Promise.resolve();
		});

		for (const { signals, stream } of streams) {
			expect(stream).toHaveBeenCalledTimes(1);
			expect(stream.mock.calls[0]?.[0]).toEqual({ ...node, userJwt: null });
			expect(signals).toHaveLength(1);
			expect(signals[0]?.aborted).toBe(false);
		}

		// The mocked stream resolves immediately. A hook-owned retry loop would make
		// a second call after its old 2s delay; the multiplexer-owned lifecycle does not.
		await new Promise((resolve) => setTimeout(resolve, 2100));
		for (const { stream } of streams) {
			expect(stream).toHaveBeenCalledTimes(1);
		}

		// A reconnect of the shared stream refetches each feed's queries without a
		// toast, since events from while it was down are never replayed.
		for (const [{ stream }, queryKey] of [
			[approval, ["approvals"]],
			[quests, ["quests"]],
			[monitors, ["monitors"]],
		] as const) {
			const onResync = stream.mock.calls[0]?.[3];
			expect(onResync).toBeInstanceOf(Function);
			invalidateQueries.mockClear();
			onResync?.();
			expect(invalidateQueries).toHaveBeenCalledTimes(1);
			expect(invalidateQueries).toHaveBeenCalledWith({ queryKey });
		}
		expect(toast.info).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();

		await act(async () => {
			root.unmount();
		});
		for (const { signals } of streams) {
			expect(signals[0]?.aborted).toBe(true);
		}
		container.remove();
	});
});
