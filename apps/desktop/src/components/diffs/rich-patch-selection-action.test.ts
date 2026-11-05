import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register();
}

afterAll(async () => {
	if (registeredHere) {
		await GlobalRegistrator.unregister();
	}
});

const { createSelectionAction } = await import(
	"./rich-patch-selection-action.ts"
);

/** A translator over the shipped locale catalog: an untranslated source fails
    the test instead of silently rendering English. */
function catalog(locale: "ar" | "de" | "ja"): LiteralMessage {
	const entries: Record<string, string> = JSON.parse(
		readFileSync(
			new URL(
				`../../../../../packages/i18n/locales/${locale}.json`,
				import.meta.url
			),
			"utf8"
		)
	);
	return (source, values) => {
		const translated = entries[source];
		if (translated === undefined || translated === source) {
			throw new Error(`Untranslated message in ${locale}: ${source}`);
		}
		return formatMessage(translated, values, locale);
	};
}

const ja = catalog("ja");
const english: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

function buttons(root: HTMLElement): string[] {
	return [...root.querySelectorAll("button")].map(
		(button) => button.textContent ?? ""
	);
}

test("a Japanese selection popover shows translated Add to chat and Copy", () => {
	const render = createSelectionAction("src/a.ts", () => undefined, ja);
	const root = render({ close: () => undefined, getSelectionText: () => "x" });
	expect(buttons(root)).toEqual(["チャットに追加", "コピー"]);
});

test("Arabic and German selection popovers translate both buttons", () => {
	const context = { close: () => undefined, getSelectionText: () => "x" };
	const arabic = createSelectionAction("a", () => undefined, catalog("ar"));
	const german = createSelectionAction("a", () => undefined, catalog("de"));
	expect(buttons(arabic(context))).toEqual(["إضافة إلى الدردشة", "نسخ"]);
	expect(buttons(german(context))).toEqual(["Zum Chat hinzufügen", "Kopieren"]);
});

test("English keeps the original Add to chat and Copy labels", () => {
	const render = createSelectionAction("a", () => undefined, english);
	const root = render({ close: () => undefined, getSelectionText: () => "x" });
	expect(buttons(root)).toEqual(["Add to chat", "Copy"]);
});

test("without a selection handler only the translated Copy button renders", () => {
	const render = createSelectionAction(undefined, undefined, ja);
	const root = render({ close: () => undefined, getSelectionText: () => "" });
	expect(buttons(root)).toEqual(["コピー"]);
});

test("Add to chat hands the file path and selected text to the handler", () => {
	const received: string[] = [];
	let closed = 0;
	const render = createSelectionAction(
		"src/a.ts",
		(text) => received.push(text),
		ja
	);
	const root = render({
		close: () => {
			closed += 1;
		},
		getSelectionText: () => "const a = 1;",
	});
	root.querySelector("button")?.click();
	expect(received).toEqual(["src/a.ts\n\nconst a = 1;"]);
	expect(closed).toBe(1);
});

test("a blank selection closes the popover without calling the handler", () => {
	const received: string[] = [];
	let closed = 0;
	const render = createSelectionAction("a", (text) => received.push(text), ja);
	const root = render({
		close: () => {
			closed += 1;
		},
		getSelectionText: () => "   ",
	});
	root.querySelector("button")?.click();
	expect(received).toEqual([]);
	expect(closed).toBe(1);
});
