import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The group's accessible name is one whole message: a translation reorders the
// frame and the eyebrows translate inside it, instead of an English
// "Current: … Change to: …" around translated values.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { BeforeAfterSummary } = await import("./before-after-summary.tsx");

const JA: Record<string, string> = {
	"{currentEyebrow}: {currentLabel}, {currentAmount}. {nextEyebrow}: {nextLabel}, {nextAmount}.":
		"{currentEyebrow}：{currentLabel}、{currentAmount}。{nextEyebrow}：{nextLabel}、{nextAmount}。",
	"After top-up": "チャージ後",
	"Change to": "変更先",
	Current: "現在",
	"Wallet balance": "ウォレット残高",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
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

async function groupLabelInJapanese(next: {
	eyebrow: string;
	label: string;
}): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<BeforeAfterSummary
					current={{
						amount: "$12.40",
						eyebrow: "Current",
						label: "Wallet balance",
					}}
					next={{ amount: "$37.40", ...next }}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const group = container.querySelector('[data-slot="before-after-summary"]');
	return group?.getAttribute("aria-label") ?? "";
}

test("the ja accessible name is one translated message with translated eyebrows", async () => {
	const label = await groupLabelInJapanese({
		eyebrow: "After top-up",
		label: "Wallet balance",
	});
	expect(label).toBe(
		"現在：ウォレット残高、$12.40。チャージ後：ウォレット残高、$37.40。"
	);
	expect(label).not.toContain("Current");
	expect(label).not.toContain("After top-up");
});

test("a plan-name label passes through while the eyebrow translates", async () => {
	const label = await groupLabelInJapanese({
		eyebrow: "Change to",
		label: "Zephyr Plan 7",
	});
	expect(label).toContain("変更先：Zephyr Plan 7");
	expect(label).not.toContain("Change to");
});
