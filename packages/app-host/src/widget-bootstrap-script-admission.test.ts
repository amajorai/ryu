// Script admission of the mounted widget document (`widgetBootstrapSrcdoc`).
//
// The frame admits script by the sha256 hash of the text the host delivered, not
// by a nonce that script inside the frame can read and reuse. A script element
// that names an address (https:, file:, anything) is not in the document at all,
// and a second policy refuses addressed script whatever attributes it carries.
//
// `widgetBootstrapSrcdoc` needs `DOMParser`, a webview API Bun does not provide. A
// small stand-in parses the script and meta elements of the input and records what
// the builder inserts, removes and rewrites; the assertions read those elements.
// What a real browser then does with the two policies is NOT run here.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	type WidgetInitialGlobals,
	widgetBootstrapSrcdoc,
} from "./widget-bootstrap.ts";

// A meta element has no end tag and no text; only a script element takes text.
const ELEMENT = /<meta\b([^>]*)>|<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ATTRIBUTE = /([^\s=]+)(?:="([^"]*)")?/g;
const HASH_SOURCE = /^'sha256-[A-Za-z0-9+/]{43}='$/;

class FakeElement {
	readonly attrs = new Map<string, string>();
	removed = false;
	readonly tag: string;
	textContent: string | null = null;

	constructor(tag: string) {
		this.tag = tag;
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	remove(): void {
		this.removed = true;
	}

	serialize(): string {
		const attrs = [...this.attrs.entries()]
			.map(([name, value]) => ` ${name}="${value}"`)
			.join("");
		return `<${this.tag}${attrs}>${this.textContent ?? ""}</${this.tag}>`;
	}
}

class FakeDocument {
	readonly body: FakeElement[] = [];
	readonly headChildren: FakeElement[] = [];
	readonly head = {
		firstChild: null as FakeElement | null,
		insertBefore: (node: FakeElement, before: FakeElement | null) => {
			const index = before ? this.headChildren.indexOf(before) : -1;
			if (index === -1) {
				this.headChildren.push(node);
			} else {
				this.headChildren.splice(index, 0, node);
			}
			this.head.firstChild = this.headChildren[0] ?? null;
		},
	};
	readonly documentElement = { outerHTML: "" };

	constructor(source: string) {
		for (const match of source.matchAll(ELEMENT)) {
			const isScript = match[2] !== undefined;
			const element = new FakeElement(isScript ? "script" : "meta");
			for (const attr of (match[1] ?? match[2] ?? "").matchAll(ATTRIBUTE)) {
				element.attrs.set((attr[1] ?? "").toLowerCase(), attr[2] ?? "");
			}
			if (isScript) {
				element.textContent = match[3] ?? "";
			}
			this.body.push(element);
		}
		Object.defineProperty(this.documentElement, "outerHTML", {
			get: () =>
				`<html><head>${this.all()
					.map((element) => element.serialize())
					.join("")}</head></html>`,
		});
	}

	/** Every element still in the document, in document order. */
	all(): FakeElement[] {
		return [...this.headChildren, ...this.body].filter(
			(element) => !element.removed
		);
	}

	createElement(tag: string): FakeElement {
		return new FakeElement(tag);
	}

	querySelectorAll(selector: string): FakeElement[] {
		const live = this.body.filter((element) => !element.removed);
		if (selector === "script") {
			return live.filter((element) => element.tag === "script");
		}
		if (selector === 'meta[http-equiv="Content-Security-Policy" i]') {
			return live.filter((element) => element.tag === "meta");
		}
		throw new Error(`unexpected selector ${selector}`);
	}
}

let mounted: FakeDocument | null = null;

class FakeDomParser {
	parseFromString(html: string): FakeDocument {
		mounted = new FakeDocument(html);
		return mounted;
	}
}

const NONCE = "handshake-nonce-1";
const MODULE_TEXT = "window.openai.toolOutput; // é";
const CLASSIC_TEXT = 'window.second = "</div>";';
const WIDGET_HTML = [
	"<!doctype html><html><head>",
	'<meta http-equiv="Content-Security-Policy" content="script-src *">',
	'</head><body><div id="root"></div>',
	'<script src="https://x.test/a.js"></script>',
	'<script src="file:///C:/Users/Public/a.js"></script>',
	'<script src="file://fileserver/share/a.js"></script>',
	`<script type="module">${MODULE_TEXT}</script>`,
	`<script>${CLASSIC_TEXT}</script>`,
	"</body></html>",
].join("");
const GLOBALS: WidgetInitialGlobals = {
	displayMode: "inline",
	locale: "en-US",
	maxHeight: 480,
	safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
	theme: "dark",
	toolInput: { q: "</script>" },
	toolOutput: { items: [1, 2, 3] },
	toolResponseMetadata: null,
	widgetState: null,
};

function hashSource(text: string): string {
	return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

function mount(nonce = NONCE, html = WIDGET_HTML): FakeDocument {
	mounted = null;
	const srcdoc = widgetBootstrapSrcdoc(
		nonce,
		Buffer.from(html, "utf8").toString("base64"),
		"server-1",
		GLOBALS
	);
	if (!mounted) {
		throw new Error("the builder did not parse the widget");
	}
	if (!srcdoc.startsWith("<!doctype html>")) {
		throw new Error("the builder did not return a document");
	}
	return mounted;
}

function scripts(doc: FakeDocument): FakeElement[] {
	return doc.all().filter((element) => element.tag === "script");
}

function policies(doc: FakeDocument): string[] {
	return doc
		.all()
		.filter(
			(element) =>
				element.tag === "meta" &&
				element.getAttribute("http-equiv") === "Content-Security-Policy"
		)
		.map((element) => element.getAttribute("content") ?? "");
}

/** The source expressions of `script-src` in the policy that carries it. */
function scriptSources(doc: FakeDocument): string[] {
	const directives = policies(doc).flatMap((policy) => policy.split("; "));
	const scriptSrc = directives.filter((directive) =>
		directive.startsWith("script-src ")
	);
	if (scriptSrc.length !== 1) {
		throw new Error(`${scriptSrc.length} script-src directives, 1 expected`);
	}
	return (scriptSrc[0] ?? "").split(" ").slice(1);
}

function addresses(doc: FakeDocument): string[] {
	return scripts(doc)
		.map((script) => script.getAttribute("src"))
		.filter((src): src is string => src !== null);
}

describe("widget frame script admission (widgetBootstrapSrcdoc)", () => {
	const globals = globalThis as { DOMParser?: unknown };
	const previousDomParser = globals.DOMParser;

	beforeAll(() => {
		globals.DOMParser = FakeDomParser;
	});

	afterAll(() => {
		globals.DOMParser = previousDomParser;
	});

	it("leaves no script element with an https address in the mounted document", () => {
		const doc = mount();
		// The stand-in saw all five script elements; three of them name an address.
		expect(doc.body.filter((element) => element.tag === "script")).toHaveLength(
			5
		);
		expect(addresses(doc).filter((src) => src.startsWith("https:"))).toEqual(
			[]
		);
		expect(doc.documentElement.outerHTML).not.toContain("x.test");
	});

	it("leaves no script element with a file: address in the mounted document (local path and network share)", () => {
		const doc = mount();
		expect(addresses(doc).filter((src) => src.startsWith("file:"))).toEqual([]);
		expect(doc.documentElement.outerHTML).not.toContain("file:");
		expect(addresses(doc)).toEqual([]);
	});

	it("keeps the nonce in the bootstrap text for the handshake and writes it on no element", () => {
		const doc = mount();
		const bootstrap = scripts(doc)[0];
		expect(bootstrap?.textContent).toContain(`var NONCE = "${NONCE}";`);
		expect(
			doc.all().filter((element) => element.getAttribute("nonce") !== null)
		).toEqual([]);
		expect(doc.documentElement.outerHTML).not.toContain("nonce=");
	});

	it("lists in script-src the sha256 hash of the bootstrap and of each inline widget script, and nothing else", () => {
		const doc = mount();
		const texts = scripts(doc).map((script) => script.textContent ?? "");
		expect(texts).toHaveLength(3);
		expect(texts.slice(1)).toEqual([MODULE_TEXT, CLASSIC_TEXT]);
		expect(scriptSources(doc)).toEqual(texts.map(hashSource));
	});

	it("holds no nonce, host, scheme or keyword source in script-src", () => {
		const sources = scriptSources(mount());
		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) {
			expect(source).toMatch(HASH_SOURCE);
		}
		expect(sources.join(" ")).not.toContain("nonce-");
	});

	it("carries a second policy that admits inline script elements only, so an integrity attribute cannot admit an address", () => {
		const doc = mount();
		expect(policies(doc)).toHaveLength(2);
		expect(policies(doc)).toContain("script-src-elem 'unsafe-inline'");
	});

	it("puts both policies ahead of every script and drops the widget's own policy", () => {
		const doc = mount();
		const order = doc.all().map((element) => element.tag);
		expect(order.slice(0, 3)).toEqual(["meta", "meta", "script"]);
		expect(order.slice(3)).toEqual(["script", "script"]);
		expect(policies(doc).join(" ")).not.toContain("script-src *");
	});

	it("hashes the bootstrap per mount and the widget's own scripts by their text alone", () => {
		const first = scriptSources(mount("nonce-a"));
		const second = scriptSources(mount("nonce-b"));
		expect(first).toHaveLength(3);
		expect(second).toHaveLength(3);
		expect(first[0]).not.toBe(second[0]);
		expect(first.slice(1)).toEqual(second.slice(1));
		expect(first.slice(1)).toEqual([MODULE_TEXT, CLASSIC_TEXT].map(hashSource));
	});

	it("admits only the bootstrap when the widget ships no inline script", () => {
		const doc = mount(
			NONCE,
			'<html><body><script src="https://x.test/only.js"></script></body></html>'
		);
		expect(scripts(doc)).toHaveLength(1);
		expect(scriptSources(doc)).toEqual([
			hashSource(scripts(doc)[0]?.textContent ?? ""),
		]);
	});
});
