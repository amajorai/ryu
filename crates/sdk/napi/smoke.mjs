// Smoke test: load the native addon and exercise the bound surface.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require("./ryu_sdk_napi.node");

const results = [];
const check = (name, fn) => {
	try {
		fn();
		results.push(`PASS ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e.message}`);
	}
};

check("exports present", () => {
	for (const k of [
		"validatePluginId",
		"parseAndValidateManifest",
		"pluginManifestJsonSchema",
		"resolveGatewayUrl",
		"assertAllowedEgress",
		"ModelClient",
	]) {
		if (!(k in addon)) {
			throw new Error(`missing export ${k}`);
		}
	}
});

check("validatePluginId accepts good id", () => {
	addon.validatePluginId("io.ryu.example");
});

check("validatePluginId rejects traversal", () => {
	let threw = false;
	try {
		addon.validatePluginId("../evil");
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected throw");
	}
});

check("parseAndValidateManifest roundtrips", () => {
	const json = JSON.stringify({
		id: "com.example.x",
		name: "X",
		version: "1.0.0",
		runnables: [
			{ id: "t", name: "T", kind: "tool", config: { slug: "web_search" } },
		],
	});
	const out = JSON.parse(addon.parseAndValidateManifest(json));
	if (out.id !== "com.example.x" || out.runnables.length !== 1) {
		throw new Error("bad roundtrip");
	}
});

check("parseAndValidateManifest rejects bad semver", () => {
	let threw = false;
	try {
		addon.parseAndValidateManifest(
			'{"id":"com.example.x","name":"X","version":"nope","runnables":[]}'
		);
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected throw");
	}
});

check("pluginManifestJsonSchema has properties", () => {
	const schema = JSON.parse(addon.pluginManifestJsonSchema());
	for (const key of ["id", "name", "version", "runnables"]) {
		if (!schema.properties?.[key]) {
			throw new Error(`schema missing ${key}`);
		}
	}
});

check("resolveGatewayUrl default", () => {
	const url = addon.resolveGatewayUrl();
	if (!url.startsWith("http")) {
		throw new Error(`unexpected url ${url}`);
	}
});

check("assertAllowedEgress blocks provider", () => {
	let threw = false;
	try {
		addon.assertAllowedEgress("https://api.openai.com");
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected throw");
	}
});

check("ModelClient rejects direct provider", () => {
	let threw = false;
	try {
		new addon.ModelClient("gpt-4o", "https://api.openai.com", null);
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected throw");
	}
});

check("ModelClient constructs against gateway + has chat/stream", () => {
	const c = new addon.ModelClient("gemma4", "http://127.0.0.1:7981", null);
	if (typeof c.chat !== "function" || typeof c.stream !== "function") {
		throw new Error("missing methods");
	}
});

for (const r of results) {
	console.log(r);
}
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length > 0) {
	process.exit(1);
}
console.log(`\nALL ${results.length} CHECKS PASSED`);
