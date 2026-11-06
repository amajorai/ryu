import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The model picker and the provider catalog reach Core; this test reads only
// the row copy, so both are stood in for with the real module's other exports.
const providerScope = await import("@/src/hooks/provider-query-scope.ts");
mock.module("@/src/hooks/provider-query-scope.ts", () => ({
	...providerScope,
	useProviderCatalog: () => ({ data: undefined }),
}));
const picker = await import(
	"@/components/agent-elements/input/agent-model-picker-field.tsx"
);
mock.module(
	"@/components/agent-elements/input/agent-model-picker-field.tsx",
	() => ({
		...picker,
		AgentModelPickerField: () => null,
	})
);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ModelDefaultsFields } = await import("./ModelDefaultsFields.tsx");

const DESCRIPTIONS: Record<string, string> = {
	"Default effort for new sessions.": "新しいセッションの既定の推論レベル。",
	"Default model for new sessions.": "新しいセッションの既定のモデル。",
	"Effort for main threads that manage work and start sessions.":
		"作業を管理しセッションを開始するメインスレッドの推論レベル。",
	"Model for main threads that manage work and start sessions.":
		"作業を管理しセッションを開始するメインスレッドのモデル。",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

test("a Japanese UI reads every model-default description in Japanese", async () => {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("ja") ? DESCRIPTIONS : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const blank = { effort: "", model: "", provider: "" };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<ModelDefaultsFields
					inherited={{ coordinator: blank, thread: blank }}
					onChange={() => undefined}
					target={{ token: null, url: "http://core.test", userJwt: null }}
					value={{ effort: "", model: "", provider: "" }}
				/>
			</I18nProvider>
		);
	});
	const text = container.textContent ?? "";
	for (const [english, japanese] of Object.entries(DESCRIPTIONS)) {
		expect(text).toContain(japanese);
		expect(text).not.toContain(english);
	}
	await act(async () => {
		root.unmount();
	});
});
