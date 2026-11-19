// The Path B builder at its own module path. Broader behavior is covered by
// `html-companion.test.ts` through the `third-party-plugin` re-export.

import { describe, expect, it } from "bun:test";
import { htmlCompanionSrcdoc } from "./html-companion-srcdoc.ts";
import { htmlCompanionSrcdoc as reExported } from "./third-party-plugin.ts";

const APP_HTML =
	"<!DOCTYPE html><html><head></head><body><script>app()</script></body></html>";

describe("htmlCompanionSrcdoc", () => {
	it("is the same function the public path re-exports", () => {
		expect(reExported).toBe(htmlCompanionSrcdoc);
	});

	it("starts with the CSP and bridge, then the app without its doctype", () => {
		const out = htmlCompanionSrcdoc("n", APP_HTML, "@ryu/x");
		expect(out).toStartWith(
			'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'
		);
		expect(out.indexOf("var ryu = {")).toBeLessThan(out.indexOf("app()"));
		expect(out).not.toContain("<!DOCTYPE html>");
	});

	it("omits the default CSP only when opted out without a declaration", () => {
		const optedOut = htmlCompanionSrcdoc(
			"n",
			APP_HTML,
			"@ryu/x",
			undefined,
			undefined,
			undefined,
			false,
			{ enforceDefaultCsp: false }
		);
		expect(optedOut).not.toContain("Content-Security-Policy");
	});
});
