// Verify the rebuilt @ryu/sdk routes its substance through the Rust core
// (@ryu/sdk-native). Imports the BUILT dist, not the source.
import * as sdk from "./dist/index.js";

const results = [];
const check = (name, fn) => {
	try {
		fn();
		results.push(`PASS ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e.message}`);
	}
};

// Gateway egress + URL resolution come from Rust.
check("resolveGatewayUrl is the Rust default", () => {
	if (sdk.resolveGatewayUrl() !== "http://127.0.0.1:7981") {
		throw new Error(`got ${sdk.resolveGatewayUrl()}`);
	}
});

check("defineModel rejects direct provider (Rust egress)", () => {
	let threw = false;
	try {
		sdk.defineModel("gpt-4o", { baseUrl: "https://api.openai.com" });
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected egress rejection");
	}
});

check("defineModel constructs against gateway", () => {
	const m = sdk.defineModel("gemma4", { baseUrl: "http://127.0.0.1:7981" });
	if (typeof m.chat !== "function" || typeof m.stream !== "function") {
		throw new Error("missing chat/stream");
	}
});

// Manifest validation helpers delegate to Rust.
check("validatePluginId (Rust) rejects non-reverse-domain", () => {
	let threw = false;
	try {
		sdk.validatePluginId("nodot");
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected rejection of dotless id");
	}
	sdk.validatePluginId("io.ryu.ok"); // should not throw
});

check("validateManifestStrict (Rust) enforces per-kind config", () => {
	// A tool runnable WITHOUT config must be rejected by Core's rules.
	let threw = false;
	try {
		sdk.validateManifestStrict(
			JSON.stringify({
				id: "com.example.x",
				name: "X",
				version: "1.0.0",
				runnables: [{ id: "t", name: "T", kind: "tool" }],
			})
		);
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("expected tool-without-config rejection");
	}
	// With config it passes.
	const ok = sdk.validateManifestStrict(
		JSON.stringify({
			id: "com.example.x",
			name: "X",
			version: "1.0.0",
			runnables: [{ id: "t", name: "T", kind: "tool", config: { slug: "s" } }],
		})
	);
	if (!ok.includes("com.example.x")) {
		throw new Error("normalized output missing id");
	}
});

check("coreManifestJsonSchema returns the Rust schema", () => {
	const schema = sdk.coreManifestJsonSchema();
	if (!schema?.properties?.version) {
		throw new Error("schema missing version");
	}
});

// The TS authoring layer (zod builders + factories) still works.
check("PluginBuilder + builders assemble a manifest", () => {
	const manifest = new sdk.PluginBuilder()
		.id("com.example.demo")
		.name("Demo")
		.version("1.0.0")
		.runnable(sdk.agent().id("agent-main").name("Main").build())
		.grant("mcp:web_search")
		.build();
	if (manifest.id !== "com.example.demo" || manifest.runnables.length !== 1) {
		throw new Error("bad manifest");
	}
});

check("defineAgent/defineTool factories produce runnables", () => {
	const a = sdk.defineAgent({ id: "a", name: "A", run: async () => ({}) });
	const t = sdk.defineTool({
		id: "t",
		name: "T",
		schema: { type: "object", properties: {} },
		run: async () => ({}),
	});
	if (a.kind !== "agent" || t.kind !== "tool") {
		throw new Error("wrong kinds");
	}
});

for (const r of results) {
	console.log(r);
}
if (results.some((r) => r.startsWith("FAIL"))) {
	process.exit(1);
}
console.log(`\nALL ${results.length} CHECKS PASSED`);
