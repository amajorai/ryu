// The seller reports inbox under a Japanese and an Arabic UI: the button that
// marks a report resolved uses the "mark as resolved" sense of "Resolve", not
// the "compute" sense (stood in for by "Resolve policy" in the stub catalog).

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MarketplaceHost, SellerReportsState } from "./host.tsx";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { MarketplaceHostProvider } = await import("./host.tsx");
const { SellerReportsPanel } = await import("./seller-reports.tsx");

// Stub catalogs: each sense of "Resolve" has its own translation.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { Resolve: "حلّ", "Resolve policy": "احتساب السياسة الفعلية" },
	ja: { Resolve: "解決", "Resolve policy": "実効ポリシーを算出" },
};

const reportsState: SellerReportsState = {
	authed: true,
	error: null,
	loading: false,
	refresh: () => undefined,
	reports: [
		{
			details: null,
			id: "report-1",
			itemId: "item-1",
			itemKind: "plugin",
			itemName: "Example plugin",
			reason: "broken",
			status: "open",
		},
	],
	resolve: () => Promise.resolve(),
};

const host: MarketplaceHost = {
	openExternal: () => undefined,
	startPurchase: () => Promise.resolve({ alreadyLicensed: false, url: "" }),
	useLicenses: () => {
		throw new Error("unused");
	},
	useSellerReports: () => reportsState,
	useSellerStatus: () => {
		throw new Error("unused");
	},
};

const roots: Root[] = [];

async function resolveButtonText(locale: string): Promise<string> {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.split("-")[0] ?? ""] ?? {}
	);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<MarketplaceHostProvider host={host}>
					<SellerReportsPanel />
				</MarketplaceHostProvider>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const item = mount.querySelector("li");
	const button = item?.querySelector("button");
	return button?.textContent?.trim() ?? "";
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("seller report Resolve button", () => {
	test("Japanese reads 解決, not the compute sense 算出", async () => {
		const text = await resolveButtonText("ja");
		expect(text).toBe("解決");
		expect(text).not.toContain("算出");
	});

	test("Arabic does not use the compute sense احتساب", async () => {
		const text = await resolveButtonText("ar");
		expect(text).toBe("حلّ");
		expect(text).not.toContain("احتساب");
	});
});
