import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { errorMessage } from "./tools/consent-cards-shared.tsx";

// A chat turn whose fetch never reached Core used to show the browser's own
// English ("Failed to fetch") inside an otherwise translated error card. These
// cases mount the real AgentChat under a Japanese catalog and pin the card body.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { AgentChat } = await import("./agent-chat.tsx");
const { chatErrorDisplay } = await import("./agent-chat-draft-error.ts");

const NETWORK =
	"Couldn't reach the server. Check your connection and try again.";
const NETWORK_JA =
	"サーバーに接続できませんでした。接続を確認してもう一度お試しください。";
const BUDGET = "Budget exceeded";
const BUDGET_JA = "予算を超えました";
const NETWORK_DE =
	"Der Server war nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.";
const NETWORK_AR = "تعذّر الوصول إلى الخادم. تحقّق من اتصالك وحاول مرة أخرى.";
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { [NETWORK]: NETWORK_AR },
	de: { [NETWORK]: NETWORK_DE },
	ja: { [BUDGET]: BUDGET_JA, [NETWORK]: NETWORK_JA },
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	registerLiteralCatalogLoader(null);
});

async function mount(error: Error, locale = "ja"): Promise<HTMLElement> {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.split("-")[0] ?? ""] ?? {}
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<AgentChat
					error={error}
					messages={[]}
					onSend={() => undefined}
					onStop={() => undefined}
					status="ready"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(0);
	});
	return host;
}

describe("AgentChat failed-request card", () => {
	test("shows the translated network sentence, not the browser's English", async () => {
		const container = await mount(new TypeError("Failed to fetch"));
		const text = container.textContent ?? "";
		expect(text).toContain(NETWORK_JA);
		expect(text).not.toContain("Failed to fetch");
	});

	test("shows the network sentence in German and Arabic too", async () => {
		for (const [locale, expected] of [
			["de", NETWORK_DE],
			["ar", NETWORK_AR],
		] as const) {
			const text =
				(await mount(new TypeError("Failed to fetch"), locale)).textContent ??
				"";
			expect(text).toContain(expected);
			expect(text).not.toContain("Failed to fetch");
			act(() => root?.unmount());
			host?.remove();
			root = null;
			host = null;
		}
	});

	test("keeps another error's own message", async () => {
		const container = await mount(new Error("Model not found: qwen3"));
		expect(container.textContent ?? "").toContain("Model not found: qwen3");
	});

	test("renders Core's localized messages when the error carries them", async () => {
		const error = Object.assign(new Error("Budget exceeded (budget)"), {
			i18n: { body: [{ message: BUDGET }], join: "sentences" },
		});
		const text = (await mount(error)).textContent ?? "";
		expect(text).toContain(BUDGET_JA);
		expect(text).not.toContain("Budget exceeded (budget)");
	});
});

describe("chatErrorDisplay", () => {
	test("is undefined without an error", () => {
		expect(chatErrorDisplay(undefined)).toBeUndefined();
	});

	test("normalizes Safari's and Firefox's fetch rejections too", () => {
		for (const message of [
			"Load failed",
			"NetworkError when attempting to fetch resource.",
		]) {
			expect(chatErrorDisplay(new TypeError(message))).toEqual({
				message: NETWORK,
			});
		}
	});

	test("ignores a non-object i18n value", () => {
		const error = Object.assign(new Error("boom"), { i18n: "nope" });
		expect(chatErrorDisplay(error)).toEqual({ message: "boom" });
	});
});

describe("consent card errorMessage", () => {
	test("gives the shared network sentence for a network failure", () => {
		expect(
			errorMessage(new TypeError("Failed to fetch"), "Install failed.")
		).toBe(NETWORK);
	});

	test("passes other errors and non-errors through unchanged", () => {
		expect(errorMessage(new Error("Plugin is disabled."), "x")).toBe(
			"Plugin is disabled."
		);
		expect(errorMessage("not an error", "Install failed.")).toBe(
			"Install failed."
		);
		const abort = new DOMException("The operation was aborted.", "AbortError");
		expect(errorMessage(abort, "x")).toBe("The operation was aborted.");
	});
});
