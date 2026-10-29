import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GiftPurchaseView } from "../../../web/src/lib/gifts-api.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@ryu/env/web", () => ({
	env: { NEXT_PUBLIC_SERVER_URL: "http://fixture.test" },
}));
const { GiftSettlement } = await import(
	"../../../web/src/app/success/gift-settlement.tsx"
);
const originalFetch = globalThis.fetch;
const originalClear = globalThis.clearTimeout;
const calls: { signal: AbortSignal; resolve: (response: Response) => void }[] =
	[];
const container = document.createElement("div");
let root = createRoot(container);
let timers = spyOn(globalThis, "setTimeout");
function retryTimers() {
	return timers.mock.calls.flatMap((args, index) => {
		const result = timers.mock.results[index];
		return args[1] === 1500 && result?.type === "return" ? [result.value] : [];
	});
}
let clears = spyOn(globalThis, "clearTimeout");
async function render(checkoutId?: string) {
	globalThis.fetch = Object.assign(
		(_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
			new Promise<Response>((resolve) => {
				if (!init?.signal) {
					throw new Error(
						"Gift reconciliation fetch requires its lifecycle AbortSignal"
					);
				}
				calls.push({
					signal: init.signal,
					resolve,
				});
			}),
		{ preconnect: originalFetch.preconnect }
	);
	await act(async () =>
		root.render(<GiftSettlement checkoutId={checkoutId} />)
	);
}
function settlementBody(status: "active" | "pending") {
	const gift: GiftPurchaseView = {
		id: "gift-fixture",
		kind: "card",
		status,
		amountCents: 1000,
		currency: "USD",
		claimCode: null,
		claimExpiresAt: null,
		claimUrl: null,
		createdAt: "2026-10-09T00:00:00Z",
		durationMonths: null,
		message: null,
		plan: null,
		recipientEmail: null,
		recipientName: null,
	};
	return { status, gift };
}
async function answer(
	index: number,
	status: "active" | "pending",
	httpStatus = 200
) {
	await act(async () =>
		calls[index].resolve(
			Response.json(settlementBody(status), { status: httpStatus })
		)
	);
}
afterEach(async () => {
	await act(async () => root.unmount());
	for (const timer of retryTimers()) {
		originalClear(timer);
	}
	timers.mockRestore();
	clears.mockRestore();
	timers = spyOn(globalThis, "setTimeout");
	clears = spyOn(globalThis, "clearTimeout");
	root = createRoot(container);
	calls.length = 0;
	globalThis.fetch = originalFetch;
});
test("checkout replacement resets status and aborts the old read", async () => {
	await render("first");
	await answer(0, "active");
	expect(container.textContent).toContain("Gift ready");
	await render("second");
	expect(container.textContent).toContain("Verifying");
	expect(calls[0].signal.aborted).toBe(true);
	await answer(1, "active");
	expect(container.textContent).toContain("Gift ready");
});
test("a delayed old response body cannot complete a replacement checkout", async () => {
	await render("first");
	let finish!: (value: ReturnType<typeof settlementBody>) => void;
	const body = new Promise<ReturnType<typeof settlementBody>>((resolve) => {
		finish = resolve;
	});
	const response = new Response(null);
	response.json = () => body;
	await act(async () => calls[0].resolve(response));
	await render("second");
	await act(async () => finish(settlementBody("active")));
	expect(container.textContent).toContain("Verifying");
	await answer(1, "active");
	expect(container.textContent).toContain("Gift ready");
});
test("unmount clears the scheduled retry instead of leaving a sleeping task", async () => {
	await render("first");
	await answer(0, "pending", 202);
	expect(retryTimers()).toHaveLength(1);
	const handle = retryTimers()[0];
	if (handle === undefined) {
		throw new Error("Gift retry did not schedule its timer");
	}
	await act(async () => root.unmount());
	root = createRoot(container);
	expect(clears).toHaveBeenCalledWith(handle);
	expect(calls[0].signal.aborted).toBe(true);
	expect(calls).toHaveLength(1);
});
test("missing checkout never starts a reconciliation read", async () => {
	await render();
	expect(calls).toHaveLength(0);
});
