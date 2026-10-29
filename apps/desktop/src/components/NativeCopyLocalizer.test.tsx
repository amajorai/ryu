import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { localizeNativeCopy } from "@/src/lib/native-copy.ts";
import { NativeCopyLocalizer } from "./NativeCopyLocalizer.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

// SAFETY: ReactDOM's act environment reads this optional global flag; only
// that boolean is written.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LITERAL = "Notifications test literal";
const FR = "Littéral de test des notifications";
const DE = "Benachrichtigungs-Testliteral";
// Overlays are keyed by the English source literal.
const OVERLAYS = { fr: { [LITERAL]: FR }, de: { [LITERAL]: DE } };

let setLocale: ((locale: string) => void) | null = null;

function LocaleHandle() {
	setLocale = useI18n().setLocale;
	return null;
}

function mount(children: ReactNode, locale: string) {
	return (
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<LocaleHandle />
			{children}
		</I18nProvider>
	);
}

describe("NativeCopyLocalizer", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		setLocale = null;
	});

	it("translates known literals and re-registers on locale change", async () => {
		await act(async () => {
			root.render(
				mount(
					createElement(NativeCopyLocalizer, { botTerminology: false }),
					"fr"
				)
			);
		});
		expect(localizeNativeCopy(LITERAL)).toBe(FR);

		await act(async () => {
			setLocale?.("de");
			await Promise.resolve();
		});
		expect(localizeNativeCopy(LITERAL)).toBe(DE);
	});

	it("passes unknown text such as agent names through unchanged", async () => {
		await act(async () => {
			root.render(
				mount(
					createElement(NativeCopyLocalizer, { botTerminology: true }),
					"en"
				)
			);
		});
		expect(localizeNativeCopy("Sales Agent")).toBe("Sales Agent");
		expect(localizeNativeCopy("Your agent finished the run")).toBe(
			"Your agent finished the run"
		);
	});

	it("unregisters on unmount", async () => {
		await act(async () => {
			root.render(
				mount(
					createElement(NativeCopyLocalizer, { botTerminology: false }),
					"fr"
				)
			);
		});
		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);
		expect(localizeNativeCopy(LITERAL)).toBe(LITERAL);
	});
});
