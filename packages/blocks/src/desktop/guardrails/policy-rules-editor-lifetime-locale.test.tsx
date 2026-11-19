// The spend cap's "Lifetime" window is an all-time total and reads through
// the keyed `usage.lifetime` (ja 累計). The bare catalog "Lifetime" is a
// one-time purchase (ja 買い切り).

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { PolicyRulesEditor } = await import("./policy-rules-editor.tsx");
const { emptyPolicyRules } = await import("./policy-model.ts");
const { budgetOptions } = await import("./policy-rules-editor-options.ts");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function windowTrigger(locale: string): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={locale === "en" ? null : `official/${locale}`}
				manageDocument={false}
				overlays={{ ja: { Lifetime: "買い切り" } }}
			>
				<PolicyRulesEditor
					locked={[]}
					onChange={() => undefined}
					onLockedChange={() => undefined}
					policyKey="gp_1"
					value={{
						...emptyPolicyRules(),
						budgets: [{ usdMicro: 5_000_000, window: "lifetime" }],
					}}
				/>
			</I18nProvider>
		);
	});
	return container.querySelector("#policy-budget-window")?.textContent ?? "";
}

test("the Japanese spend cap names the all-time window 累計", async () => {
	expect(await windowTrigger("ja")).toContain("累計");
});

test("English keeps Lifetime", async () => {
	expect(await windowTrigger("en")).toContain("Lifetime");
});

test("the options resolve only the lifetime window through the sense", () => {
	const options = budgetOptions((id, fallback) =>
		id === "usage.lifetime" ? "累計" : fallback
	);
	expect(options.map((option) => option.label)).toEqual([
		"No cap",
		"Per day",
		"Per week",
		"Per month",
		"累計",
	]);
	expect(budgetOptions().at(-1)?.label).toBe("Lifetime");
});
