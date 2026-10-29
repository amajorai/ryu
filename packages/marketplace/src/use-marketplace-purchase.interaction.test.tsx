import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { sileo } from "sileo";
import { type MarketplaceHost, MarketplaceHostProvider } from "./host.tsx";
import type { PurchaseResult } from "./types.ts";
import {
	type UseMarketplacePurchaseResult,
	useMarketplacePurchase,
} from "./use-marketplace-purchase.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root;
let container: HTMLDivElement;
let purchase: UseMarketplacePurchaseResult;
let success: ReturnType<typeof successSpy>;
let error: ReturnType<typeof errorSpy>;

function successSpy() {
	return spyOn(sileo, "success").mockImplementation(() => "toast");
}

function errorSpy() {
	return spyOn(sileo, "error").mockImplementation(() => "toast");
}

function Probe() {
	purchase = useMarketplacePurchase();
	return <output>{purchase.buying ?? "idle"}</output>;
}

function host(overrides: Partial<MarketplaceHost> = {}) {
	const refresh = mock(async () => undefined);
	const startPurchase = mock(
		async (): Promise<PurchaseResult> => ({
			alreadyLicensed: false,
			url: "https://checkout.example.com/session",
		})
	);
	const openExternal = mock(async () => undefined);
	return {
		refresh,
		startPurchase,
		openExternal,
		value: {
			startPurchase,
			openExternal,
			useLicenses: () => ({
				authed: true,
				error: null,
				loading: false,
				licenses: [],
				isLicensed: (_kind, id) => id === "owned",
				refresh,
			}),
			useSellerStatus: () => {
				throw new Error("Purchase must not load seller data");
			},
			...overrides,
		} satisfies MarketplaceHost,
	};
}

async function mount(value: MarketplaceHost) {
	await act(async () => {
		root.render(
			<MarketplaceHostProvider host={value}>
				<Probe />
			</MarketplaceHostProvider>
		);
	});
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	success = successSpy();
	error = errorSpy();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	success.mockRestore();
	error.mockRestore();
});

describe("marketplace purchase workflow", () => {
	test("keeps the item busy until the checkout handoff resolves, then clears it", async () => {
		let release!: () => void;
		const handoff = new Promise<void>((resolve) => {
			release = resolve;
		});
		const openExternal = mock(() => handoff);
		const services = host({ openExternal });
		await mount(services.value);
		let pending!: Promise<void>;
		await act(async () => {
			pending = purchase.buy({ kind: "app", id: "paid-app" });
		});
		expect(services.startPurchase).toHaveBeenCalledWith({
			kind: "app",
			id: "paid-app",
		});
		expect(openExternal).toHaveBeenCalledWith(
			"https://checkout.example.com/session"
		);
		expect(container.textContent).toBe("paid-app");
		expect(success).not.toHaveBeenCalled();
		await act(async () => {
			release();
			await pending;
		});
		expect(container.textContent).toBe("idle");
		expect(success).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Opening checkout…" })
		);
		expect(services.refresh).not.toHaveBeenCalled();
	});

	test("canceling the purchase guard never requests a charge or opens checkout", async () => {
		const guardPurchase: MarketplaceHost["guardPurchase"] = mock(
			async () => null
		);
		const services = host({ guardPurchase });
		await mount(services.value);
		await act(async () => purchase.buy({ kind: "skill", id: "cancelled" }));
		expect(guardPurchase).toHaveBeenCalledTimes(1);
		expect(services.startPurchase).not.toHaveBeenCalled();
		expect(services.openExternal).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(purchase.buying).toBeNull();
	});

	test("confirmation forwards the original item to the payment host", async () => {
		const guardPurchase: MarketplaceHost["guardPurchase"] = async (action) =>
			action();
		const services = host({ guardPurchase });
		await mount(services.value);
		await act(async () => purchase.buy({ kind: "agent", id: "confirmed" }));
		expect(services.startPurchase).toHaveBeenCalledTimes(1);
		expect(services.startPurchase).toHaveBeenCalledWith({
			kind: "agent",
			id: "confirmed",
		});
		expect(services.openExternal).toHaveBeenCalledTimes(1);
	});

	test("an already-owned result refreshes licenses without opening a second checkout", async () => {
		const startPurchase = mock(async () => ({
			alreadyLicensed: true,
			url: "https://checkout.example.com/stale",
		}));
		const services = host({ startPurchase });
		await mount(services.value);
		await act(async () => purchase.buy({ kind: "app", id: "owned" }));
		expect(services.refresh).toHaveBeenCalledTimes(1);
		expect(services.openExternal).not.toHaveBeenCalled();
		expect(purchase.isLicensed("app", "owned")).toBe(true);
		expect(success).toHaveBeenCalledWith({
			title: "You already own this item.",
		});
		expect(purchase.buying).toBeNull();
	});

	test("missing checkout URL gives actionable failure and allows another purchase", async () => {
		const startPurchase = mock(async () => ({
			alreadyLicensed: false,
			url: "",
		}));
		const services = host({ startPurchase });
		await mount(services.value);
		await act(async () => purchase.buy({ kind: "app", id: "first" }));
		expect(error).toHaveBeenCalledWith({ title: "Could not start checkout." });
		expect(services.openExternal).not.toHaveBeenCalled();
		expect(purchase.buying).toBeNull();
		startPurchase.mockImplementation(async () => ({
			alreadyLicensed: false,
			url: "https://checkout.example.com/retry",
		}));
		await act(async () => purchase.buy({ kind: "app", id: "first" }));
		expect(startPurchase).toHaveBeenCalledTimes(2);
		expect(services.openExternal).toHaveBeenCalledWith(
			"https://checkout.example.com/retry"
		);
	});

	for (const failingStage of [
		"payment",
		"browser",
		"license refresh",
	] as const) {
		test(`${failingStage} rejection displays the reason, clears busy state, and never reports checkout success`, async () => {
			const failure = new Error(`${failingStage} unavailable`);
			const services = host();
			if (failingStage === "payment") {
				services.startPurchase.mockImplementation(async () => {
					throw failure;
				});
			}
			if (failingStage === "browser") {
				services.openExternal.mockImplementation(async () => {
					throw failure;
				});
			}
			if (failingStage === "license refresh") {
				services.startPurchase.mockImplementation(async () => ({
					alreadyLicensed: true,
					url: "",
				}));
				services.refresh.mockImplementation(async () => {
					throw failure;
				});
			}
			await mount(services.value);
			await act(async () => purchase.buy({ kind: "app", id: "broken" }));
			expect(error).toHaveBeenCalledWith({ title: failure.message });
			expect(purchase.buying).toBeNull();
			expect(
				success.mock.calls.some(
					([message]) => message.title === "Opening checkout…"
				)
			).toBe(false);
		});
	}
});
