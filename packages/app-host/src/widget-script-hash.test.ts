// The synchronous SHA-256 behind widget script admission, and the pass that drops
// addressed script elements and lists the hash of every inline one.

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	admitWidgetScripts,
	scriptHashSource,
	sha256Base64,
} from "./widget-script-hash.ts";

function reference(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("base64");
}

describe("sha256Base64", () => {
	it("matches the published vectors", () => {
		expect(sha256Base64("")).toBe(
			"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
		);
		expect(sha256Base64("abc")).toBe(
			"ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
		);
	});

	it("matches node:crypto for every length across three block edges", () => {
		for (let length = 0; length <= 200; length += 1) {
			const text = "a".repeat(length);
			expect(sha256Base64(text)).toBe(reference(text));
		}
	});

	it("hashes the UTF-8 bytes of non-ASCII script text", () => {
		for (const text of [
			'console.log("é ü ß")',
			"const s = '日本語 한국어 العربية';",
			"/* 😀 */ export default 1;\n",
			"\u0000\u007f\u0080\u07ff\u0800\uffff",
		]) {
			expect(sha256Base64(text)).toBe(reference(text));
		}
	});

	it("matches node:crypto for a bundle-sized text", () => {
		const text = "const value = 'é' + 1; // 0123456789\n".repeat(30_000);
		expect(text.length).toBeGreaterThan(1_000_000);
		expect(sha256Base64(text)).toBe(reference(text));
	});
});

describe("scriptHashSource", () => {
	it("is one quoted sha256 source expression", () => {
		const source = scriptHashSource('console.log("widget")');
		expect(source).toBe(`'sha256-${reference('console.log("widget")')}'`);
		expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
	});
});

class FakeScript {
	readonly attrs: Map<string, string>;
	removed = false;
	textContent: string | null;

	constructor(attrs: Record<string, string>, text: string | null) {
		this.attrs = new Map(Object.entries(attrs));
		this.textContent = text;
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	remove(): void {
		this.removed = true;
	}
}

function fakeDocument(scripts: FakeScript[]) {
	return {
		querySelectorAll: (_selector: "script") =>
			scripts.filter((script) => !script.removed),
	};
}

describe("admitWidgetScripts", () => {
	it("removes every script element that names an address, whatever the scheme", () => {
		const addressed = [
			new FakeScript({ src: "https://cdn.example.com/a.js" }, ""),
			new FakeScript({ src: "file:///C:/Users/Public/a.js" }, ""),
			new FakeScript({ src: "file://fileserver/share/a.js" }, ""),
			new FakeScript({ src: "data:text/javascript,alert(1)" }, ""),
			new FakeScript({ src: "blob:null/1234" }, ""),
			new FakeScript({ src: "./relative.js", type: "module" }, ""),
			new FakeScript({ src: "" }, "ignored()"),
			new FakeScript({ href: "https://cdn.example.com/svg.js" }, ""),
			new FakeScript({ "xlink:href": "https://cdn.example.com/svg.js" }, ""),
		];
		const sources = admitWidgetScripts(fakeDocument(addressed));
		expect(sources).toEqual([]);
		expect(addressed.map((script) => script.removed)).toEqual(
			addressed.map(() => true)
		);
	});

	it("keeps inline scripts and returns the hash source of each text once", () => {
		const moduleScript = new FakeScript({ type: "module" }, "import.meta;");
		const classic = new FakeScript({}, "window.a = 1;");
		const repeated = new FakeScript({}, "window.a = 1;");
		const empty = new FakeScript({}, null);
		const sources = admitWidgetScripts(
			fakeDocument([moduleScript, classic, repeated, empty])
		);
		expect(sources).toEqual([
			`'sha256-${reference("import.meta;")}'`,
			`'sha256-${reference("window.a = 1;")}'`,
			`'sha256-${reference("")}'`,
		]);
		expect(
			[moduleScript, classic, repeated, empty].some((script) => script.removed)
		).toBe(false);
	});

	it("does not treat an integrity or nonce attribute as an address", () => {
		const script = new FakeScript(
			{ integrity: "sha256-AAAA", nonce: "widget-chosen" },
			"window.b = 2;"
		);
		expect(admitWidgetScripts(fakeDocument([script]))).toEqual([
			`'sha256-${reference("window.b = 2;")}'`,
		]);
		expect(script.removed).toBe(false);
	});
});
