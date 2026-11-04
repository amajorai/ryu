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
const { DoctorSummary } = await import("./doctor-summary.tsx");

// The posture card renders each Gateway Doctor finding from its check id, so a
// Japanese user reads the summary, detail and action as three catalog
// messages (the DOM localizer is off here, so the component must translate).
const JA: Record<string, string> = {
	"Firewall scanning is only partially enabled":
		"ファイアウォールのスキャンは一部のみ有効です",
	"Inbound scanning is {inbound, select, on {on} other {off}}; outbound scanning is {outbound, select, on {on} other {off}}.":
		"受信スキャンは{inbound, select, on {オン} other {オフ}}、送信スキャンは{outbound, select, on {オン} other {オフ}}です。",
	"Keep both inbound and outbound scanning enabled unless you have a documented exception.":
		"文書化された例外がない限り、受信と送信の両方のスキャンを有効にしてください。",
	Warning: "警告",
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

test("a Japanese posture card shows the finding's translated sentences", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<DoctorSummary
					compact={false}
					report={{
						counts: { errors: 0, info: 0, warnings: 1 },
						findings: [
							{
								canAutoFix: true,
								category: "security",
								checkId: "security.partial-firewall-scan",
								detail: "Inbound scanning is off; outbound scanning is on.",
								recommendedAction:
									"Keep both inbound and outbound scanning enabled unless you have a documented exception.",
								settingPath: "firewall.scan_inbound",
								severity: "warning",
								summary: "Firewall scanning is only partially enabled",
							},
						],
					}}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const row = container.querySelector(
		'[data-doctor-check-id="security.partial-firewall-scan"]'
	);
	const text = row?.textContent ?? "";
	expect(text).toContain("ファイアウォールのスキャンは一部のみ有効です");
	expect(text).toContain("受信スキャンはオフ、送信スキャンはオンです。");
	expect(text).toContain("文書化された例外がない限り");
	expect(text).not.toContain("Inbound scanning");
	expect(row?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
		"警告"
	);
});
