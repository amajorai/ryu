// The /pricing credit-plan cards mirror under dir="rtl", so the arrow keys that
// move between them swap there: → still selects the card on the right.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
const { creditPlanKeyTarget } = await import("./credit-plan-keys.ts");
const { StandaloneCreditPlans } = await import("./standalone-credit-plans.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { root, container } = mounted;
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

describe("creditPlanKeyTarget", () => {
	test("left-to-right: ArrowRight and ArrowDown move forward, wrapping", () => {
		expect(creditPlanKeyTarget("ArrowRight", 0, 3)).toBe(1);
		expect(creditPlanKeyTarget("ArrowDown", 2, 3)).toBe(0);
		expect(creditPlanKeyTarget("ArrowLeft", 0, 3)).toBe(2);
		expect(creditPlanKeyTarget("ArrowUp", 1, 3)).toBe(0);
	});

	test("right-to-left: the horizontal arrows swap, vertical ones do not", () => {
		expect(creditPlanKeyTarget("ArrowLeft", 0, 3, "rtl")).toBe(1);
		expect(creditPlanKeyTarget("ArrowRight", 0, 3, "rtl")).toBe(2);
		expect(creditPlanKeyTarget("ArrowDown", 0, 3, "rtl")).toBe(1);
		expect(creditPlanKeyTarget("ArrowUp", 0, 3, "rtl")).toBe(2);
	});

	test("Home, End and other keys", () => {
		expect(creditPlanKeyTarget("Home", 2, 3, "rtl")).toBe(0);
		expect(creditPlanKeyTarget("End", 0, 3)).toBe(2);
		expect(creditPlanKeyTarget("Enter", 0, 3)).toBeNull();
	});
});

async function renderPlans(locale: string): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<StandaloneCreditPlans onCheckout={() => undefined} />
			</I18nProvider>
		);
	});
	return container;
}

async function pressOnChecked(container: HTMLElement, key: string) {
	const checked = container.querySelector<HTMLButtonElement>(
		'[role="radio"][aria-checked="true"]'
	);
	await act(async () => {
		checked?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key })
		);
	});
	return container
		.querySelector('[role="radio"][aria-checked="true"]')
		?.getAttribute("aria-label");
}

describe("StandaloneCreditPlans arrow keys", () => {
	test("ArrowRight selects the next plan in English", async () => {
		const container = await renderPlans("en");
		const radios = [...container.querySelectorAll('[role="radio"]')].map(
			(radio) => radio.getAttribute("aria-label")
		);
		expect(radios.length).toBe(3);
		expect(await pressOnChecked(container, "ArrowRight")).toBe(radios[1]);
	});

	test("ArrowLeft selects the next plan in Arabic, where the cards mirror", async () => {
		const container = await renderPlans("ar");
		const radios = [...container.querySelectorAll('[role="radio"]')].map(
			(radio) => radio.getAttribute("aria-label")
		);
		expect(await pressOnChecked(container, "ArrowLeft")).toBe(radios[1]);
		expect(await pressOnChecked(container, "ArrowRight")).toBe(radios[0]);
	});
});
