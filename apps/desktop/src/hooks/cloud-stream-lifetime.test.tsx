import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
interface Feed {
	returned: boolean;
	send: <TValue>(value: TValue) => void;
	signal: AbortSignal;
}
const wallet: Feed[] = [];
const billing: Feed[] = [];
const alerts: Feed[] = [];
function stream(list: Feed[], signal: AbortSignal) {
	const feed: Feed = { signal, send: () => {}, returned: false };
	list.push(feed);
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((resolve) => {
						feed.send = (data) => resolve({ done: false, value: { data } });
					}),
				return: () => {
					feed.returned = true;
					return Promise.resolve({ done: true, value: undefined });
				},
			};
		},
	};
}
mock.module("@/src/lib/api/credits.ts", () => ({
	hasCreditsAuth: () => true,
	isTerminalCreditsError: () => false,
	openWalletStream: (signal: AbortSignal) => stream(wallet, signal),
	openCreditAlertStream: (signal: AbortSignal) => stream(alerts, signal),
}));
mock.module("@/src/lib/api/teams-billing.ts", () => ({
	hasTeamsBillingAuth: () => true,
	openBillingStatusStream: (signal: AbortSignal) => stream(billing, signal),
}));
const toasts: unknown[] = [];
mock.module("@ryu/ui/components/sileo", () => ({
	toast: { warning: <TValue,>(value: TValue) => toasts.push(value) },
}));
const { useWalletStream } = await import("./useWalletStream.ts");
const { useBillingStatusStream } = await import("./useBillingStatusStream.ts");
const { useCreditAlertEvents } = await import("./useCreditAlertEvents.ts");
const notices: string[] = [];
let grant: (value: string) => void = () => {};
const original = globalThis.Notification;
class Notice {
	static permission = "default";
	static requestPermission() {
		return new Promise<string>((resolve) => {
			grant = resolve;
		});
	}
	constructor(title: string) {
		notices.push(title);
	}
}
Reflect.set(globalThis, "Notification", Notice);
const root = createRoot(document.createElement("div"));
let latest: unknown;
function Probe({ org }: { org: string }) {
	latest = useWalletStream(org);
	useBillingStatusStream();
	useCreditAlertEvents();
	return null;
}
const tick = async (action: () => void) => {
	await act(async () => {
		action();
		await Bun.sleep(0);
	});
};
afterEach(async () => {
	await act(() => root.unmount());
	Reflect.set(globalThis, "Notification", original);
});
test("old-org wallet frames and post-teardown billing/alert frames are discarded", async () => {
	await tick(() => root.render(<Probe org="a" />));
	await tick(() => alerts[0].send({ title: "Fixture" }));
	expect(toasts).toHaveLength(1);
	await tick(() => root.render(<Probe org="b" />));
	expect(wallet[0].signal.aborted).toBe(true);
	await tick(() => wallet[0].send({ balance: "old" }));
	expect(latest).toBeNull();
	expect(wallet[0].returned).toBe(true);
	await tick(() => wallet[1].send({ balance: "current" }));
	expect(latest).toEqual({ balance: "current" });
	await tick(() => root.render(null));
	await tick(() => {
		billing[0].send({ status: "late" });
		alerts[0].send({ title: "late" });
		grant("granted");
	});
	expect(billing[0].returned).toBe(true);
	expect(alerts[0].returned).toBe(true);
	expect(toasts).toHaveLength(1);
	expect(notices).toHaveLength(0);
});
