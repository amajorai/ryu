// The spend-cap field reads the cap in the UI locale: a German admin's
// "100,50" reaches the policy instead of being silently dropped, and a saved
// cap is shown back with a comma.

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
type PolicyRules = import("./policy-model.ts").PolicyRules;

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

async function renderEditor(locale: string, changes: PolicyRules[]) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<PolicyRulesEditor
					locked={[]}
					onChange={(next) => changes.push(next)}
					onLockedChange={() => undefined}
					policyKey="gp_1"
					value={{
						...emptyPolicyRules(),
						budgets: [{ usdMicro: 20_250_000, window: "monthly" }],
					}}
				/>
			</I18nProvider>
		);
	});
	const field = container.querySelector<HTMLInputElement>(
		"#policy-budget-amount"
	);
	if (!field) {
		throw new Error("the budget amount field did not render");
	}
	return field;
}

async function typeInto(field: HTMLInputElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

test("German prefills the saved cap with a comma and accepts 100,50", async () => {
	const changes: PolicyRules[] = [];
	const field = await renderEditor("de", changes);
	expect(field.value).toBe("20,25");
	await typeInto(field, "100,50");
	expect(changes.at(-1)?.budgets).toEqual([
		{ usdMicro: 100_500_000, window: "monthly" },
	]);
	expect(field.getAttribute("aria-invalid")).toBe("false");
});

test("English keeps the period decimal", async () => {
	const changes: PolicyRules[] = [];
	const field = await renderEditor("en", changes);
	expect(field.value).toBe("20.25");
	await typeInto(field, "7.5");
	expect(changes.at(-1)?.budgets).toEqual([
		{ usdMicro: 7_500_000, window: "monthly" },
	]);
});
