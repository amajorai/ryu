// Path A document scaffolding: the head, the bootstrap prelude, and the activation
// tail that `thirdPartyPluginSrcdoc` composes around `makePlugin`/`installWindowRyu`.

import { describe, expect, it } from "bun:test";
import {
	pluginActivationScript,
	pluginBridgePrelude,
	pluginDocumentHead,
} from "./plugin-srcdoc-document.ts";
import { companionRpcResultSettleScript } from "./rpc-error-decode-script.ts";

const LITERALS = {
	codeLiteral: '"Y29kZQ=="',
	mountContextLiteral: '{"docId":"d"}',
	nonceLiteral: '"n-1"',
	pluginIdLiteral: '"@ryu/x"',
	themeTokensLiteral: "null",
};

describe("pluginDocumentHead", () => {
	it("places the locale attributes, CSP meta and theme head", () => {
		const head = pluginDocumentHead(
			'lang="ar" dir="rtl"',
			"<meta data-csp />",
			"<style>t</style>"
		);
		expect(head).toStartWith('<!doctype html>\n<html lang="ar" dir="rtl">');
		expect(head).toContain("<meta data-csp />");
		expect(head).toContain("<style>t</style>\n</head>");
		expect(head).toEndWith('<div id="ryu-plugin-root"></div>');
	});
});

describe("pluginBridgePrelude", () => {
	it("bakes the literals and settles results with the shared fragment", () => {
		const prelude = pluginBridgePrelude(LITERALS, false);
		expect(prelude).toStartWith("<script>\n  (function () {");
		expect(prelude).toContain('var NONCE = "n-1";');
		expect(prelude).toContain('var PLUGIN_ID = "@ryu/x";');
		expect(prelude).toContain('var MOUNT_CONTEXT = {"docId":"d"};');
		expect(prelude).toContain(companionRpcResultSettleScript());
	});

	it("only changes the Escape handling when asked to close on Escape", () => {
		expect(pluginBridgePrelude(LITERALS, true)).not.toBe(
			pluginBridgePrelude(LITERALS, false)
		);
	});
});

describe("pluginActivationScript", () => {
	it("accepts the port by nonce and closes the document", () => {
		const tail = pluginActivationScript();
		expect(tail).toContain('msg.kind !== "ryu-plugin-host-port"');
		expect(tail).toEndWith("</script>\n</body>\n</html>");
	});

	it("forms a parseable script with the prelude", () => {
		const prelude = pluginBridgePrelude(LITERALS, false);
		const tail = pluginActivationScript();
		const script = `${prelude.slice("<script>".length)}\n${tail.slice(
			0,
			tail.indexOf("</script>")
		)}`;
		expect(() => new Function(script)).not.toThrow();
	});
});
