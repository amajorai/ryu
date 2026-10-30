import { afterEach, describe, expect, test } from "bun:test";

import type { CompanionI18nApi } from "./dom-localizer-host.ts";
import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { observeDomLocalization } = await import("./dom-localizer.ts");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");
const { I18nRuntime } = await import("./core.ts");
const { localizeDomRoot } = await import("./react-dom-localizer.tsx");

type Runtime = InstanceType<typeof I18nRuntime>;

const GERMAN: Record<string, string> = {
	"Pick a value": "Wert wählen",
	Pricing: "Preise",
	"Ripple mode": "Ripple-Modus",
	"Send now": "Jetzt senden",
	Slide: "Folie",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function germanRuntime(locale = "de"): Runtime {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? GERMAN : null
	);
	return new I18nRuntime([], { initialLocale: locale, initialPackId: null });
}

function stateOf(runtime: Runtime) {
	return () => ({
		availablePacks: runtime.availablePacks,
		hasOverlayMessage: (id: string) => runtime.overlayMessage(id) !== undefined,
		t: (id: string, values?: Record<string, string>, fallback?: string) =>
			runtime.translate(id, values, fallback),
	});
}

function query(selector: string, root: ParentNode = document): Element {
	const element = root.querySelector(selector);
	if (!element) {
		throw new Error(`missing ${selector}`);
	}
	return element;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

describe("observeDomLocalization", () => {
	test("translate aria attributes, button values and the page title", async () => {
		const runtime = germanRuntime();
		document.head.innerHTML = "<title>Pricing  ·  Ryu</title>";
		document.body.innerHTML = [
			'<div aria-roledescription="Slide" aria-placeholder="Pick a value" aria-valuetext="Ripple mode"></div>',
			'<input type="submit" value="Send now"><input type="text" value="Send now">',
			"<p>Ripple\n   mode</p><p>Use {name} here</p>",
		].join("");
		const stop = observeDomLocalization({
			state: stateOf(runtime),
			translationKey: () => String(runtime.getVersion()),
		});
		await settle();
		const div = query("div");
		expect(div.getAttribute("aria-roledescription")).toBe("Folie");
		expect(div.getAttribute("aria-placeholder")).toBe("Wert wählen");
		expect(div.getAttribute("aria-valuetext")).toBe("Ripple-Modus");
		expect(query('input[type="submit"]').getAttribute("value")).toBe(
			"Jetzt senden"
		);
		// A text field's value is user data.
		expect(query('input[type="text"]').getAttribute("value")).toBe("Send now");
		expect(document.title).toBe("Preise  ·  Ryu");
		const paragraphs = document.querySelectorAll("p");
		expect(paragraphs[0]?.textContent).toBe("Ripple-Modus");
		// Unknown text is never ICU-formatted.
		expect(paragraphs[1]?.textContent).toBe("Use {name} here");

		const span = document.createElement("span");
		span.setAttribute("title", "Slide");
		document.body.append(span);
		await settle();
		expect(span.getAttribute("title")).toBe("Folie");
		stop();
	});

	test("localize a shadow root and follow the runtime's locale", async () => {
		const runtime = germanRuntime("en");
		const shadowHost = document.createElement("div");
		document.body.append(shadowHost);
		const shadow = shadowHost.attachShadow({ mode: "closed" });
		shadow.innerHTML =
			'<button>Ripple mode</button><span data-ryu-i18n="off">Ripple mode</span>';
		const outside = document.createElement("p");
		outside.textContent = "Ripple mode";
		document.body.append(outside);
		const stop = localizeDomRoot(runtime, shadow);
		runtime.setLocale("de");
		await settle();
		expect(query("button", shadow).textContent).toBe("Ripple-Modus");
		expect(query("span", shadow).textContent).toBe("Ripple mode");
		expect(outside.textContent).toBe("Ripple mode");
		runtime.setLocale("en");
		await settle();
		expect(query("button", shadow).textContent).toBe("Ripple mode");
		stop();
	});
});

describe("Companion literals through the host", () => {
	function companionHost(answers: Record<string, string>) {
		const requests: string[] = [];
		const hostRuntime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		const host: CompanionI18nApi = {
			get: () => Promise.resolve(hostRuntime.getSnapshot()),
			subscribe: () => ({ dispose: () => undefined }),
			translate: ({ defaultMessage, id }) => {
				requests.push(defaultMessage);
				return Promise.resolve(
					answers[defaultMessage] ??
						hostRuntime.translate(id, undefined, defaultMessage)
				);
			},
		};
		return { host, requests };
	}

	test("plain JSX literals reach the DOM translated; off and data stay", async () => {
		registerLiteralCatalogLoader(null);
		const runtime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		const { host, requests } = companionHost({
			"Frob the widget": "Widget frobben",
		});
		document.body.innerHTML = [
			"<p>Frob the widget</p>",
			"<p>Has {braces} data</p>",
			'<p data-ryu-i18n="off">Frob the widget</p>',
		].join("");
		const stop = observeDomLocalization({
			host,
			state: stateOf(runtime),
			translationKey: () => String(runtime.getVersion()),
		});
		await settle();
		await settle();
		const paragraphs = document.querySelectorAll("p");
		expect(paragraphs[0]?.textContent).toBe("Widget frobben");
		expect(paragraphs[1]?.textContent).toBe("Has {braces} data");
		expect(paragraphs[2]?.textContent).toBe("Frob the widget");
		expect(requests.filter((text) => text === "Has {braces} data")).toEqual([
			"Has {braces} data",
		]);
		stop();
	});
});

describe("dynamic sentences through catalog templates", () => {
	const TEMPLATES: Record<string, string> = {
		...GERMAN,
		"Deleted {name}": "{name} gelöscht",
		"Search {scope}": "{scope} durchsuchen",
	};

	function templateRuntime(): Runtime {
		registerLiteralCatalogLoader((requested) =>
			requested.startsWith("de") ? TEMPLATES : null
		);
		return new I18nRuntime([], { initialLocale: "de", initialPackId: null });
	}

	test("translate text and attributes around their values", async () => {
		const runtime = templateRuntime();
		document.body.innerHTML = [
			"<p>Deleted   Q3 (draft) [v2] {x}</p>",
			'<input aria-label="Search Inbox $1" placeholder="Search *.md">',
			"<p>Deleted</p><p>Removed Q3 plan</p>",
		].join("");
		const stop = localizeDomRoot(runtime, document.body);
		await settle();
		const paragraphs = document.querySelectorAll("p");
		expect(paragraphs[0]?.textContent).toBe("Q3 (draft) [v2] {x} gelöscht");
		const input = query("input");
		expect(input.getAttribute("aria-label")).toBe("Inbox $1 durchsuchen");
		expect(input.getAttribute("placeholder")).toBe("*.md durchsuchen");
		expect(paragraphs[1]?.textContent).toBe("Deleted");
		expect(paragraphs[2]?.textContent).toBe("Removed Q3 plan");
		stop();
	});

	test("a Companion host answers dynamic text through its templates", async () => {
		templateRuntime();
		const hostRuntime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		const frameRuntime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		const host: CompanionI18nApi = {
			get: () => Promise.resolve(hostRuntime.getSnapshot()),
			subscribe: () => ({ dispose: () => undefined }),
			translate: ({ defaultMessage, id }) =>
				Promise.resolve(hostRuntime.translate(id, undefined, defaultMessage)),
		};
		document.body.innerHTML = "<p>Deleted report.pdf</p>";
		const stop = observeDomLocalization({
			host,
			state: stateOf(frameRuntime),
			translationKey: () => String(frameRuntime.getVersion()),
		});
		await settle();
		await settle();
		expect(query("p").textContent).toBe("report.pdf gelöscht");
		stop();
	});
});
