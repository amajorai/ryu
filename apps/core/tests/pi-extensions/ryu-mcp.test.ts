import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(
	import.meta.dir,
	"../../assets/pi-extensions/ryu-mcp.ts"
);

test("native Pi MCP transport retains opaque widget JSON and capability headers", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "ryu-mcp-native-"));
	const capability = process.env.RYU_MCP_SESSION_CAPABILITY;
	const broker = process.env.RYU_MCP_ACP_SESSION_ID;
	process.env.RYU_MCP_SESSION_CAPABILITY = "native-fixture-capability";
	process.env.RYU_MCP_ACP_SESSION_ID = "native-fixture-broker";
	const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({
			tools: [{ id: "fixture.echo", description: "Echo JSON\nExtra" }],
		})
	);
	try {
		const loaded = await discoverAndLoadExtensions(
			[extensionPath],
			directory,
			directory
		);
		expect(loaded.errors).toEqual([]);
		const extension = loaded.extensions.find(
			(item) => item.resolvedPath === extensionPath
		);
		if (!extension) {
			throw new Error("Native MCP extension not loaded");
		}
		const session = SessionManager.inMemory(directory);
		const models = await ModelRuntime.create({
			authPath: resolve(directory, "auth.json"),
			modelsPath: null,
			modelsStorePath: resolve(directory, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			directory,
			session,
			new ModelRegistry(models)
		);
		const call = extension.tools.get("ryu_call_tool");
		const list = extension.tools.get("ryu_list_tools");
		if (!(call && list)) {
			throw new Error("Native MCP tools missing");
		}
		// Native MCP is available, so the catalog is not folded into the proxy
		// description: the granted tools arrive as deferred `mcp__ryu__*` tools.
		expect(call.definition.description).not.toContain("fixture.echo");
		expect(call.definition.description).toContain("mcp__ryu__");
		await runner.emit({ type: "session_start", reason: "startup" });
		const registered = loaded.runtime.mcpServers
			.list()
			.find((server) => server.name === "ryu");
		expect(registered?.extensionPath).toBe(extensionPath);
		expect(registered?.config).toMatchObject({
			url: "http://127.0.0.1:7980/api/acp/mcp",
			exposure: "deferred",
			toolExposure: { ask_user: "direct", execute: "hidden", resume: "hidden" },
			headers: {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Pi's header syntax, not a template.
				authorization: "Bearer ${RYU_MCP_SESSION_CAPABILITY}",
				"x-ryu-acp-native-session-id": session.getSessionId(),
			},
		});
		// Pi expands the capability from its environment; the config never holds it.
		expect(JSON.stringify(registered?.config)).not.toContain(
			"native-fixture-capability"
		);
		const output = JSON.parse(
			'{"content":[{"type":"image","data":"opaque"},{"type":"text","text":"First"},{"type":"text","text":"Second"}],"structuredContent":{"__proto__":{"opaque":true},"future":{"nested":[false,0,null]}},"_meta":{"app":{"id":"fixture"}}}'
		);
		fetch.mockResolvedValue(Response.json({ ok: true, output }));
		const args = JSON.parse(
			'{"__proto__":{"safe":"own"},"future":[false,0,null]}'
		);
		const result = await call.definition.execute(
			"call",
			{ tool: "fixture.echo", arguments: args },
			undefined,
			undefined,
			runner.createContext()
		);
		expect(result.content).toEqual([{ type: "text", text: "First\nSecond" }]);
		expect(JSON.stringify(result.details)).toBe(
			JSON.stringify({
				ryuWidget: { tool: "fixture.echo", arguments: args, output },
			})
		);
		const input = fetch.mock.calls.at(-1)?.[1];
		const headers = new Headers(input?.headers);
		expect(headers.get("authorization")).toBe(
			"Bearer native-fixture-capability"
		);
		expect(headers.get("x-ryu-acp-session-id")).toBe("native-fixture-broker");
		expect(headers.get("x-ryu-acp-native-session-id")).toBe(
			session.getSessionId()
		);
		expect(input?.body).toBe(
			JSON.stringify({
				action: "call_tool",
				tool: "fixture.echo",
				arguments: args,
			})
		);
		fetch.mockResolvedValue(
			Response.json({
				ok: true,
				output: { structuredContent: { widget: "only" } },
			})
		);
		expect(
			(
				await call.definition.execute(
					"widget",
					{ tool: "fixture.echo" },
					undefined,
					undefined,
					runner.createContext()
				)
			).content
		).toEqual([{ type: "text", text: '{"widget":"only"}' }]);
		fetch.mockResolvedValue(
			Response.json({ ok: false, error: "Core refusal" }, { status: 403 })
		);
		await expect(
			call.definition.execute(
				"refused",
				{ tool: "fixture.echo" },
				undefined,
				undefined,
				runner.createContext()
			)
		).rejects.toThrow("ryu_call_tool: fixture.echo failed: Core refusal");
		fetch.mockResolvedValue(
			Response.json({
				tools: [
					{ id: "fixture.echo", description: "Echo" },
					{ id: "fixture.other", description: "Other" },
				],
			})
		);
		expect(
			(
				await list.definition.execute(
					"list",
					{ query: "echo" },
					undefined,
					undefined,
					runner.createContext()
				)
			).details
		).toEqual({ count: 1 });
		fetch.mockResolvedValue(Response.json({ tools: [{ id: 123 }] }));
		expect(
			(
				await list.definition.execute(
					"invalid",
					{},
					undefined,
					undefined,
					runner.createContext()
				)
			).details
		).toEqual({ count: 0 });
	} finally {
		fetch.mockRestore();
		if (capability === undefined) {
			delete process.env.RYU_MCP_SESSION_CAPABILITY;
		} else {
			process.env.RYU_MCP_SESSION_CAPABILITY = capability;
		}
		if (broker === undefined) {
			delete process.env.RYU_MCP_ACP_SESSION_ID;
		} else {
			process.env.RYU_MCP_ACP_SESSION_ID = broker;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("Core's script sandbox is hidden only while Pi's codemode is active", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "ryu-mcp-codemode-"));
	const capability = process.env.RYU_MCP_SESSION_CAPABILITY;
	const broker = process.env.RYU_MCP_ACP_SESSION_ID;
	process.env.RYU_MCP_SESSION_CAPABILITY = "codemode-fixture-capability";
	process.env.RYU_MCP_ACP_SESSION_ID = "codemode-fixture-broker";
	const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ tools: [] })
	);
	try {
		const loaded = await discoverAndLoadExtensions(
			[extensionPath],
			directory,
			directory
		);
		expect(loaded.errors).toEqual([]);
		const models = await ModelRuntime.create({
			authPath: resolve(directory, "auth.json"),
			modelsPath: null,
			modelsStorePath: resolve(directory, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			directory,
			SessionManager.inMemory(directory),
			new ModelRegistry(models)
		);
		const exposure = () =>
			loaded.runtime.mcpServers.list().find((server) => server.name === "ryu")
				?.config.toolExposure;

		// `"defaultTools": ["-codemode"]`: Pi has no script sandbox of its own,
		// so Core's keeps the server's deferred exposure.
		loaded.runtime.getActiveTools = () => ["read", "bash", "tool_search"];
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(exposure()).toEqual({ ask_user: "direct" });

		// Codemode on (Core's managed default): only one sandbox is offered.
		loaded.runtime.getActiveTools = () => ["read", "bash", "codemode"];
		await runner.emit({ type: "session_start", reason: "reload" });
		expect(exposure()).toEqual({
			ask_user: "direct",
			execute: "hidden",
			resume: "hidden",
		});
	} finally {
		fetch.mockRestore();
		if (capability === undefined) {
			delete process.env.RYU_MCP_SESSION_CAPABILITY;
		} else {
			process.env.RYU_MCP_SESSION_CAPABILITY = capability;
		}
		if (broker === undefined) {
			delete process.env.RYU_MCP_ACP_SESSION_ID;
		} else {
			process.env.RYU_MCP_ACP_SESSION_ID = broker;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

interface GatewayImageRequest {
	init?: RequestInit;
	url: string;
}

/**
 * Load the extension against a fixture Gateway, register its image models and
 * run one generation. `imagesData` is the Gateway's `data[]`; `hosted` answers
 * any other URL (hosted image downloads).
 */
async function generateThroughGateway(
	imagesData: unknown[],
	hosted: (url: string) => Response = () => Response.json({ tools: [] })
) {
	const directory = await mkdtemp(resolve(tmpdir(), "ryu-mcp-images-"));
	const modelsPath = resolve(directory, "models.json");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: "http://gateway.test/v1",
					api: "openai-responses",
					apiKey: "gateway-fixture-key",
					headers: { "x-ryu-node-routing": "fixture-routing" },
					models: [{ id: "openrouter/auto" }],
				},
			},
		})
	);
	const requests: GatewayImageRequest[] = [];
	const fetch = spyOn(globalThis, "fetch").mockImplementation(
		async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "http://gateway.test/v1/models") {
				return Response.json({
					data: [
						{ id: "openrouter/auto" },
						{ id: "gemini-3.1-flash-image", modality: "image" },
					],
				});
			}
			if (url === "http://gateway.test/v1/images/generations") {
				return Response.json({ data: imagesData });
			}
			return hosted(url);
		}
	);
	try {
		const loaded = await discoverAndLoadExtensions(
			[extensionPath],
			directory,
			directory
		);
		if (loaded.errors.length) {
			throw new Error(
				`extension failed to load: ${JSON.stringify(loaded.errors)}`
			);
		}
		const models = await ModelRuntime.create({
			authPath: resolve(directory, "auth.json"),
			modelsPath,
			modelsStorePath: resolve(directory, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const registry = new ModelRegistry(models);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			directory,
			SessionManager.inMemory(directory),
			registry
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		// Discovery is detached from session start. Without `bindCore` (real Pi
		// binds before session start) the runtime queues the registration;
		// flush it the way `bindCore` does.
		const pending = loaded.runtime.pendingProviderRegistrations;
		for (let attempt = 0; !pending.length && attempt < 100; attempt += 1) {
			await Bun.sleep(10);
		}
		for (const { name, config } of pending) {
			registry.registerProvider(name, config);
		}
		const image = registry.findOfType(
			"image",
			"ryu-gateway-images",
			"gemini-3.1-flash-image"
		);
		if (!image) {
			throw new Error("Gateway image model was not registered");
		}
		const chatModelAsImage = registry.findOfType(
			"image",
			"ryu-gateway-images",
			"openrouter/auto"
		);
		const result = await registry.generateImages(image, {
			input: [{ type: "text", text: "a red fox" }],
		});
		return { chatModelAsImage, result, requests };
	} finally {
		fetch.mockRestore();
		await rm(directory, { recursive: true, force: true });
	}
}

test("Gateway image models register with Pi and generate through the Gateway", async () => {
	const { chatModelAsImage, result, requests } = await generateThroughGateway([
		{ b64_json: "AQID", content_type: "image/png" },
	]);
	expect(chatModelAsImage).toBeUndefined();
	expect(result.stopReason).toBe("stop");
	expect(result.output).toEqual([
		{ type: "image", mimeType: "image/png", data: "AQID" },
	]);
	const call = requests.find(
		(request) => request.url === "http://gateway.test/v1/images/generations"
	);
	const headers = new Headers(call?.init?.headers);
	expect(headers.get("authorization")).toBe("Bearer gateway-fixture-key");
	expect(headers.get("x-ryu-node-routing")).toBe("fixture-routing");
	expect(JSON.parse(String(call?.init?.body))).toEqual({
		model: "gemini-3.1-flash-image",
		prompt: "a red fox",
		response_format: "b64_json",
	});
});

const hostedImageUrl = "https://images.test/fox.png";
const maxHostedImageBytes = 20 * 1024 * 1024;

test("hosted Gateway image URLs are downloaded inline when small and typed as images", async () => {
	const { result } = await generateThroughGateway(
		[{ url: hostedImageUrl }],
		() =>
			new Response(new Uint8Array([1, 2, 3]), {
				headers: { "content-type": "image/webp" },
			})
	);
	expect(result.stopReason).toBe("stop");
	expect(result.output).toEqual([
		{ type: "image", mimeType: "image/webp", data: "AQID" },
	]);
});

test("hosted Gateway image downloads over the byte cap are rejected", async () => {
	let pulled = 0;
	const chunk = new Uint8Array(1024 * 1024);
	const { result } = await generateThroughGateway(
		[{ url: hostedImageUrl }],
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						pulled += chunk.byteLength;
						controller.enqueue(chunk);
					},
				}),
				{ headers: { "content-type": "image/png" } }
			)
	);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("image too large");
	// The unbounded stream was abandoned shortly after the cap, not drained.
	expect(pulled).toBeLessThan(maxHostedImageBytes + 4 * chunk.byteLength);
});

test("hosted Gateway image downloads declaring an oversized length are rejected", async () => {
	const { result } = await generateThroughGateway(
		[{ url: hostedImageUrl }],
		() =>
			new Response(new Uint8Array([1, 2, 3]), {
				headers: {
					"content-type": "image/png",
					"content-length": String(maxHostedImageBytes + 1),
				},
			})
	);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("image too large");
});

test("hosted Gateway image downloads that are not images are rejected", async () => {
	const { result } = await generateThroughGateway(
		[{ url: hostedImageUrl }],
		() =>
			new Response("<html></html>", {
				headers: { "content-type": "text/html" },
			})
	);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("not an image");
});
