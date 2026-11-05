import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { CampaignDetail } = await import("./campaign-detail.tsx");

// The campaign header's date range and the stat tiles' composite values are
// whole catalog messages, so an Arabic user sees the range with the mirrored
// arrow and the submission counts translated (the DOM localizer is off here,
// so the component must translate them itself).
const AR: Record<string, string> = {
	"of {amount}": "من {amount}",
	"{pending} pending · {approved} approved":
		"{pending} قيد الانتظار · {approved} معتمدة",
	"{start} → {end}": "{start} ← {end}",
};

const SUMMARY = {
	accrued_cents: 1000,
	approved_cents: 500,
	budget_cents: 50_000,
	committed_cents: 0,
	creators: 2,
	paid_cents: 0,
	remaining_cents: 49_000,
	submissions: { approved: 12, paid: 0, pending: 4, rejected: 0 },
	total_comments: 0,
	total_likes: 7,
	total_views: 90,
};

const roots: Root[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
	globalThis.fetch = originalFetch;
});

function stubUgcApi() {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input);
		let body: unknown = { submissions: [] };
		if (url.includes("/summary")) {
			body = SUMMARY;
		} else if (url.includes("/leaderboard")) {
			body = { leaderboard: [] };
		}
		return Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
	}) as typeof fetch;
}

test("an Arabic campaign shows the date range and stat values as catalog messages", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ar") ? AR : {}));
	stubUgcApi();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ar"
				initialPackId={null}
			>
				<CampaignDetail
					campaign={{
						brand: "Acme",
						budget_cents: 50_000,
						ends_at: "2026-02-01T00:00:00Z",
						id: "camp_1",
						starts_at: "2026-01-01T00:00:00Z",
						status: "active",
					}}
					composioConfigured={null}
					creatorName={(id) => id}
					creators={[]}
					invalidate={() => undefined}
					onOpenGatewayKeys={() => undefined}
					platformLabel={(platform) => platform}
					platforms={[]}
					revision={0}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

	const text = container.textContent ?? "";
	expect(text).toContain("←");
	expect(text).not.toContain("→");
	expect(text).toContain("قيد الانتظار");
	expect(text).toContain("معتمدة");
	expect(text).not.toMatch(/\bpending\b|\bapproved\b · |\bof \$/);
	expect(text).toContain("من ");
});
