import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The composer's context ring prints its percentage in the reader's number
// format: a hand-built `${n}%` showed "42%" to German readers ("42 %") and
// Latin digits to Arabic readers beside Arabic-Indic formatPercent output.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { ContextMeter } = await import("./context-meter.tsx");

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

async function meterText(locale: string): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ContextMeter usage={{ total: 100, used: 42 }} />
			</I18nProvider>
		);
	});
	return container.textContent ?? "";
}

test("shows the used share as 42% in English", async () => {
	expect(await meterText("en")).toBe("42%");
});

test("puts the German no-break space before the percent sign", async () => {
	expect(await meterText("de")).toBe("42 %");
});

test("uses Arabic-Indic digits and the Arabic percent sign in ar-EG", async () => {
	const text = await meterText("ar-EG");
	expect(text).toContain("٤٢");
	expect(text).toContain("٪");
	expect(text).not.toContain("42");
});
