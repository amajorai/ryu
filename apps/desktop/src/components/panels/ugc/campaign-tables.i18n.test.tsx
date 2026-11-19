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
const { SubmissionsTable } = await import("./campaign-tables.tsx");

const SUBMISSION = {
	accrued_cents: 0,
	creator_id: "creator-1",
	id: "submission-1",
	latest: null,
	payout_status: null,
	platform: "tiktok",
	post_url: "https://example.com/post/1",
	status: "approved",
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("the German Post column names the social post, not the posting verb", async () => {
	// The bare word is the verb (Posten); the column keys its own sense.
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("de") ? { Post: "Posten" } : null
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId="official/de"
			>
				<SubmissionsTable
					creatorName={() => "Ada"}
					hasMetricSource={() => false}
					onApprove={() => undefined}
					onRecordMetrics={() => undefined}
					onRefresh={() => undefined}
					onReject={() => undefined}
					platformLabel={() => "TikTok"}
					submissions={[SUBMISSION as never]}
				/>
			</I18nProvider>
		);
	});
	const headers = [...container.querySelectorAll("th")].map(
		(cell) => cell.textContent
	);
	expect(headers).toContain("Beitrag");
	expect(headers).not.toContain("Posten");
});
