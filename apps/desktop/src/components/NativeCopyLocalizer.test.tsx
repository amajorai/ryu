import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	buildNativeShellCopy,
	localizeNativeCopy,
	type NativeShellCopy,
	nativeShellLabelIds,
} from "@/src/lib/native-copy.ts";
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

interface TauriWindow {
	__TAURI_INTERNALS__?: unknown;
}

describe("native shell copy", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const sent: NativeShellCopy[] = [];

	beforeEach(() => {
		sent.length = 0;
		(window as TauriWindow).__TAURI_INTERNALS__ = {
			invoke: (command: string, args: { copy?: NativeShellCopy }) => {
				if (command === "set_native_copy" && args.copy) {
					sent.push(args.copy);
				}
				return Promise.resolve(null);
			},
			transformCallback: () => 0,
		};
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		(window as TauriWindow).__TAURI_INTERNALS__ = undefined;
	});

	it("declares exactly the label ids the Rust shell reads", () => {
		const rust = readFileSync(
			new URL("../../src-tauri/src/native_copy.rs", import.meta.url),
			"utf8"
		);
		const rustIds = [...rust.matchAll(/pub const \w+: &str = "([^"]+)";/gu)]
			.map((match) => match[1])
			.sort();
		expect(nativeShellLabelIds().sort()).toEqual(rustIds);
	});

	it("sends one template per plural category with the count placeholder", () => {
		const english = buildNativeShellCopy((source) => source, "en");
		expect(english.pluralCategories[1]).toBe("one");
		expect(english.pluralCategories[2]).toBe("other");
		expect(english.digits).toBe("0123456789");

		const tl = (source: string, values?: Record<string, number | string>) =>
			source.startsWith("{count, plural")
				? `${values?.count} tasks`
				: source.replace("{app}", String(values?.app ?? ""));
		const arabic = buildNativeShellCopy(tl, "ar");
		const categories = new Set(arabic.pluralCategories);
		expect(categories).toEqual(
			new Set(["zero", "one", "two", "few", "many", "other"])
		);
		for (const category of categories) {
			expect(arabic.labels[`quit.message.${category}`]).toBe("{count} tasks");
		}
		expect(arabic.labels["menu.about"]).toBe("About {app}");
	});

	it("follows the UI language end to end (Arabic plurals, German menu)", async () => {
		// The English sources exactly as native-copy.ts hands them to `tl()`.
		const sources: string[] = [];
		buildNativeShellCopy((source) => {
			sources.push(source);
			return source;
		}, "en");
		const quitSource = sources.find((source) =>
			source.includes("local task is still running")
		);
		expect(quitSource).toBeDefined();
		const overlays = {
			ar: {
				[quitSource ?? ""]:
					"{count, plural, zero {لا مهام} one {مهمة واحدة قيد التشغيل.} two {مهمتان قيد التشغيل.} few {# مهام قيد التشغيل.} many {# مهمة قيد التشغيل.} other {# مهمة قيد التشغيل.}}",
				"About {app}": "حول {app}",
			},
			de: { Edit: "Bearbeiten", "Hide {app}": "{app} ausblenden" },
		};
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="ar"
					initialPackId={null}
					manageDocument={false}
					overlays={overlays}
				>
					<LocaleHandle />
					<NativeCopyLocalizer botTerminology={false} />
				</I18nProvider>
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const arabic = sent.at(-1);
		expect(arabic?.pluralCategories[2]).toBe("two");
		expect(arabic?.pluralCategories[3]).toBe("few");
		expect(arabic?.pluralCategories[11]).toBe("many");
		// A form that spells the number out is sent verbatim.
		expect(arabic?.labels["quit.message.two"]).toBe("مهمتان قيد التشغيل.");
		expect(arabic?.labels["quit.message.few"]).toBe(
			"{count} مهام قيد التشغيل."
		);
		expect(arabic?.labels["quit.message.many"]).toBe(
			"{count} مهمة قيد التشغيل."
		);
		// `{app}` survives translation for the shell to fill natively.
		expect(arabic?.labels["menu.about"]).toBe("حول {app}");

		await act(async () => {
			setLocale?.("de");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const german = sent.at(-1);
		expect(german?.labels["menu.edit"]).toBe("Bearbeiten");
		expect(german?.labels["menu.hide"]).toBe("{app} ausblenden");
		expect(german?.pluralCategories.slice(0, 3)).toEqual([
			"other",
			"one",
			"other",
		]);
	});

	it("hands the shell its copy in the active language", async () => {
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="en"
					initialPackId={null}
					manageDocument={false}
				>
					<NativeCopyLocalizer botTerminology={false} />
				</I18nProvider>
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const copy = sent.at(-1);
		expect(copy?.labels["tray.show"]).toBe("Show Ryu");
		expect(copy?.labels["quit.message.one"]).toBe(
			"{count} local task is still running. Quitting Ryu will stop it. Keep the app open until it finishes, or quit anyway."
		);
		expect(copy?.labels["update.messageActive.other"]).toStartWith(
			"{count} local tasks are running."
		);
	});
});
