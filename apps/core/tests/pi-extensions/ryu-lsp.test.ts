import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	"../../assets/pi-extensions/ryu-lsp.ts"
);

test("native LSP child preserves framing, diagnostics versions, opaque hierarchy and teardown", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "ryu-lsp-native-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const log = resolve(directory, "requests.jsonl");
	let shutdown: (() => Promise<void>) | undefined;
	try {
		await mkdir(resolve(directory, "extensions"));
		await writeFile(
			resolve(directory, "extensions/ryu-lsp.json"),
			JSON.stringify({
				servers: {
					fixture: {
						command: process.execPath,
						args: [resolve(import.meta.dir, "lsp-server.fixture.mjs"), log],
						extensionToLanguage: { ".ts": "typescript" },
						settings: { native: true },
						shutdownTimeout: 1000,
					},
				},
			})
		);
		const source = resolve(directory, "café 診断.ts");
		await writeFile(source, "const café = true;\n");
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
			throw new Error("Native LSP extension missing");
		}
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
		shutdown = async () => {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
		};
		await expect(readFile(log)).rejects.toThrow();
		const diagnostics = extension.tools.get("lsp_diagnostics");
		const definition = extension.tools.get("lsp_definition");
		const hover = extension.tools.get("lsp_hover");
		const hierarchy = extension.tools.get("lsp_call_hierarchy");
		if (!(diagnostics && definition && hover && hierarchy)) {
			throw new Error("Native LSP tools missing");
		}
		const ctx = runner.createContext();
		const diagnosticResult = await diagnostics.definition.execute(
			"diagnose",
			{ path: source },
			undefined,
			undefined,
			ctx
		);
		expect(diagnosticResult.content).toMatchObject([
			{ type: "text", text: expect.stringContaining("Fresh café 診断") },
		]);
		expect(JSON.stringify(diagnosticResult)).not.toContain("Stale error");
		expect(diagnosticResult.details).toEqual({ count: 1 });
		expect(
			(
				await definition.definition.execute(
					"definition",
					{ path: source, line: 1, column: 1 },
					undefined,
					undefined,
					ctx
				)
			).content
		).toMatchObject([
			{ type: "text", text: expect.stringContaining("café 診断.ts:5:3") },
		]);
		expect(
			(
				await hover.definition.execute(
					"hover",
					{ path: source },
					undefined,
					undefined,
					ctx
				)
			).content
		).toMatchObject([
			{
				type: "text",
				text: expect.stringContaining("Café\n\n診断 documentation"),
			},
		]);
		const tree = await hierarchy.definition.execute(
			"hierarchy",
			{ path: source, direction: "outgoing", depth: 2 },
			undefined,
			undefined,
			ctx
		);
		expect(JSON.stringify(tree.content)).toContain("Root");
		expect(JSON.stringify(tree.content)).toContain("Child");
		await writeFile(source, "const café = false;\n");
		const updated = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "write",
			toolName: "write",
			input: { path: source, content: "const café = false;\n" },
			content: [{ type: "text", text: "Original write output" }],
			details: undefined,
			isError: false,
		});
		expect(updated?.content?.[0]).toEqual({
			type: "text",
			text: "Original write output",
		});
		expect(updated?.content?.[1]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Fresh café 診断"),
		});
		expect(JSON.stringify(updated)).not.toContain("Stale error");
		// `copy_paste` (the pi-copy plugin) diagnoses the file it pasted into.
		const pasted = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "paste",
			toolName: "copy_paste",
			input: { path: "elsewhere.txt", start_line: 1, to_path: source },
			content: [{ type: "text", text: "Copied line 1" }],
			details: undefined,
			isError: false,
		});
		expect(pasted?.content?.[0]).toEqual({
			type: "text",
			text: "Copied line 1",
		});
		expect(pasted?.content?.[1]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Fresh café 診断"),
		});
		// A cross-file move also rewrote the source, so it is diagnosed too.
		const moved = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "move",
			toolName: "copy_paste",
			input: {
				path: source,
				start_line: 1,
				to_path: "elsewhere.txt",
				move: true,
			},
			content: [{ type: "text", text: "Moved line 1" }],
			details: undefined,
			isError: false,
		});
		expect(moved?.content?.[0]).toEqual({ type: "text", text: "Moved line 1" });
		expect(moved?.content?.[1]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Fresh café 診断"),
		});
		await shutdown();
		shutdown = undefined;
		const requests = await readFile(log, "utf8");
		expect(requests).toContain(
			'"id":1001,"result":[{"native":true},{"native":true}]'
		);
		expect(requests).toContain('"id":1002,"result":null');
		expect(requests).toContain('"__proto__":{"retained":"yes"}');
		expect(requests).toContain('"method":"textDocument/didClose"');
		expect(requests).toContain('"method":"shutdown"');
		const pid = Number(await readFile(`${log}.pid`, "utf8"));
		expect(Number.isInteger(pid) && pid > 0).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await shutdown?.();
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing or malformed LSP config registers no native tools or handlers", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "ryu-lsp-empty-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await mkdir(resolve(directory, "extensions"));
		for (const config of [
			undefined,
			"",
			"{invalid",
			"null",
			'{"metadata":{"version":1}}',
		]) {
			if (config !== undefined) {
				await writeFile(resolve(directory, "extensions/ryu-lsp.json"), config);
			}
			const loaded = await discoverAndLoadExtensions(
				[extensionPath],
				directory,
				directory
			);
			expect(loaded.errors).toEqual([]);
			const extension = loaded.extensions.find(
				(item) => item.resolvedPath === extensionPath
			);
			expect(extension?.tools.size).toBe(0);
			expect(extension?.handlers.size).toBe(0);
		}
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
		await rm(directory, { recursive: true, force: true });
	}
});
