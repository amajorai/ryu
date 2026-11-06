import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider, useLiteralMessages } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { privacySaveFailureToast } = await import(
	"./privacy-save-failure-copy.ts"
);

type Choice = "analytics" | "community" | "crashes" | "export";

const JA: Record<string, string> = {
	"Couldn't save your analytics choice": "分析の設定を保存できませんでした",
	"Couldn't save your community-stats choice":
		"コミュニティ統計の設定を保存できませんでした",
	"Couldn't save your crash-report choice":
		"クラッシュレポートの設定を保存できませんでした",
	"Couldn't save your diagnostics-export choice":
		"診断エクスポートの設定を保存できませんでした",
	"Your previous choice is restored. Check your connection and retry saving.":
		"以前の設定に戻しました。接続を確認して、もう一度保存してください。",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

function ToastProbe({ choice }: { choice: Choice }) {
	const tl = useLiteralMessages();
	const { description, title } = privacySaveFailureToast(tl, choice);
	return (
		<p>
			<strong>{title}</strong> {description}
		</p>
	);
}

test("a Japanese UI shows each privacy save failure toast in Japanese", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const choices: Choice[] = ["analytics", "community", "crashes", "export"];
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				{choices.map((choice) => (
					<ToastProbe choice={choice} key={choice} />
				))}
			</I18nProvider>
		);
	});
	const text = container.textContent ?? "";
	for (const [english, japanese] of Object.entries(JA)) {
		expect(text).toContain(japanese);
		expect(text).not.toContain(english);
	}
	expect(text).not.toContain("Couldn't save");
	await act(async () => {
		root.unmount();
	});
});

test("an English UI names the switch that failed", () => {
	const english = (source: string) => source;
	expect(privacySaveFailureToast(english, "crashes").title).toBe(
		"Couldn't save your crash-report choice"
	);
	expect(privacySaveFailureToast(english, "export").title).toBe(
		"Couldn't save your diagnostics-export choice"
	);
});
