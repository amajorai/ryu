/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import {
	type FixtureRecord,
	fixtureRecordSchema,
	parseFixtureJson,
} from "../proof/cli-fixture-contract.ts";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let testSetup: Setup | null = null;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let isolatedHome: string | null = null;
beforeEach(() => {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-interactions-"));
	process.env.HOME = isolatedHome;
	delete process.env.USERPROFILE;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(isolatedHome)
	);
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (isolatedHome) {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
	isolatedHome = null;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
});

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

async function press(setup: Setup, key: KeyInput): Promise<void> {
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	});
}

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 80
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Inference settings render did not match: ${frame}`);
	}
	return frame;
}

async function openInferenceSettings(setup: Setup): Promise<string> {
	await waitForFrame(setup, (frame) => frame.includes("Message"));
	await press(setup, { name: "k", ctrl: true });
	for (const character of "settings") {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Node connection is managed")
	);
	// Inference is appended to the System group so prior settings navigation keeps
	// its established order: General, Features, Appearance, ... Danger Zone, Inference.
	// Island is not a CLI panel, so Inference is twenty-two panel steps away.
	for (let index = 0; index < 22; index += 1) {
		await press(setup, { name: "j" });
	}
	return waitForFrame(setup, (frame) => frame.includes("Advanced inference"));
}

const preferenceEnvelopeSchema = z.object({ value: z.string() });
interface RequestRecord {
	body?: FixtureRecord;
	method: string;
	path: string;
}

function installInferenceCore(
	storedValue: () => string | null,
	onPut?: () => Response
) {
	const requests: RequestRecord[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			const body = init?.body
				? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
				: undefined;
			requests.push({ body, method, path: url.pathname });
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/engines") {
				return Response.json({
					engines: [
						{ id: "llamacpp", name: "llamacpp", installed: true },
						{ id: "openai", name: "openai", installed: true },
						{ id: "ollama", name: "ollama", installed: true },
						{ id: "vllm", name: "vllm", installed: true },
						{ id: "sglang", name: "sglang", installed: true },
						{ id: "mlx", name: "mlx", installed: true },
					],
				});
			}
			if (url.pathname === "/api/preferences/inference.engine.llamacpp") {
				if (method === "PUT") {
					return onPut?.() ?? Response.json({ value: storedValue() });
				}
				return Response.json({
					key: "inference.engine.llamacpp",
					value: storedValue(),
				});
			}
			return Response.json({});
		},
		realFetch
	);
	return requests;
}

function installLaunchCore(initial: Record<string, string | null> = {}) {
	const requests: RequestRecord[] = [];
	const preferences = new Map(Object.entries(initial));
	let launchReadFailures = 0;
	let launchWriteFailures = 0;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			const body = init?.body
				? fixtureRecordSchema.parse(parseFixtureJson(String(init.body)))
				: undefined;
			requests.push({ body, method, path: url.pathname });
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/engines") {
				return Response.json({
					engines: [
						{ id: "llamacpp", name: "llamacpp", installed: true },
						{ id: "openai", name: "openai", installed: true },
						{ id: "ollama", name: "ollama", installed: true },
						{ id: "vllm", name: "vllm", installed: true },
						{ id: "sglang", name: "sglang", installed: true },
						{ id: "mlx", name: "mlx", installed: true },
					],
				});
			}
			const prefix = "/api/preferences/";
			if (url.pathname.startsWith(prefix)) {
				const key = decodeURIComponent(url.pathname.slice(prefix.length));
				if (
					key === "model.launch.engine.llamacpp" &&
					method === "GET" &&
					launchReadFailures > 0
				) {
					launchReadFailures -= 1;
					return Response.json(
						{ error: "temporary launch read failure" },
						{ status: 503 }
					);
				}
				if (key.startsWith("model.launch.engine.") && method === "PUT") {
					if (
						key === "model.launch.engine.llamacpp" &&
						launchWriteFailures > 0
					) {
						launchWriteFailures -= 1;
						return Response.json(
							{ error: "temporary launch write failure" },
							{ status: 503 }
						);
					}
					const value = z.string().safeParse(body?.value).data;
					if (value !== undefined) {
						preferences.set(key, value);
					}
				}
				return Response.json({ key, value: preferences.get(key) ?? null });
			}
			return Response.json({});
		},
		realFetch
	);
	return {
		failNextRead: () => {
			launchReadFailures += 1;
		},
		failNextWrite: () => {
			launchWriteFailures += 1;
		},
		preferences,
		requests,
	};
}

test("engine sampling defaults use Core preference GET/PUT and restore the saved value after app reload", async () => {
	let stored: string | null = null;
	const requests = installInferenceCore(
		() => stored,
		() => {
			const put = requests.findLast(
				(item) =>
					item.path === "/api/preferences/inference.engine.llamacpp" &&
					item.method === "PUT"
			);
			const body = preferenceEnvelopeSchema.parse(put?.body);
			stored = body?.value ?? null;
			return Response.json({ value: stored });
		}
	);
	let setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await waitForFrame(setup, (frame) => frame.includes("llamacpp"));
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("0.8");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("0.8"));
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);

	const writes = requests.filter(
		(item) =>
			item.path === "/api/preferences/inference.engine.llamacpp" &&
			item.method === "PUT"
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]?.body).toEqual({ value: '{"temperature":0.8}' });
	expect(
		requests.filter(
			(item) =>
				item.path === "/api/preferences/inference.engine.llamacpp" &&
				item.method === "GET"
		).length
	).toBeGreaterThanOrEqual(2); // Initial read plus post-save readback.

	await act(async () => {
		setup.renderer.destroy();
		await Promise.resolve();
	});
	setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	const reloaded = await waitForFrame(setup, (frame) => frame.includes("0.8"));
	expect(reloaded).toContain("0.8");
	expect(
		requests.filter(
			(item) =>
				item.path === "/api/preferences/inference.engine.llamacpp" &&
				item.method === "GET"
		).length
	).toBeGreaterThanOrEqual(3);
});

test("sampling validation blocks out-of-range numbers and unsafe logit bias before any Core write", async () => {
	const requests = installInferenceCore(() => null);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await waitForFrame(setup, (frame) => frame.includes("llamacpp"));

	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("2.1");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Temperature must be no greater than 2.")
	);
	await press(setup, { name: "tab" });

	// In the llama.cpp field list Logit bias follows the four basic fields, four
	// extended sampling controls, stop, penalties, repetition, Mirostat and samplers.
	for (let index = 0; index < 27; index += 1) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("Logit bias (JSON)"));
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText('{"12":101}');
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Bias values must be numbers from -100 to 100.")
	);
	await press(setup, { name: "s" });
	expect(
		requests.filter(
			(item) =>
				item.path === "/api/preferences/inference.engine.llamacpp" &&
				item.method === "PUT"
		)
	).toHaveLength(0);
});

test("engine selection exposes the same extended sampler fields as Desktop only for supported runtimes", async () => {
	const requests = installInferenceCore(() => null);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	const firstEngine = await waitForFrame(setup, (frame) =>
		frame.includes("Temperature (1/30)")
	);
	expect(firstEngine).toContain("Temperature (1/30)");
	for (let index = 0; index < 4; index += 1) {
		await press(setup, { name: "j" });
	}
	await waitForFrame(setup, (frame) => frame.includes("Top K (5/30)"));

	await press(setup, { name: "right" });
	const otherEngine = await waitForFrame(setup, (frame) =>
		frame.includes("Temperature (1/11)")
	);
	expect(otherEngine).toContain("Engine openai");
	for (let index = 0; index < 4; index += 1) {
		await press(setup, { name: "j" });
	}
	const standardOnly = await waitForFrame(setup, (frame) =>
		frame.includes("Stop sequences (JSON array)")
	);
	expect(standardOnly).not.toContain("Top K");
	expect(
		requests.some(
			(item) =>
				item.path === "/api/preferences/inference.engine.openai" &&
				item.method === "GET"
		)
	).toBe(true);
});

test("failed sampling save keeps the draft and retries the exact Core preference write", async () => {
	let stored: string | null = null;
	let putAttempts = 0;
	const requests = installInferenceCore(
		() => stored,
		() => {
			putAttempts += 1;
			if (putAttempts === 1) {
				return Response.json(
					{ error: "temporary preference failure" },
					{ status: 503 }
				);
			}
			const put = requests.findLast(
				(item) =>
					item.path === "/api/preferences/inference.engine.llamacpp" &&
					item.method === "PUT"
			);
			stored = preferenceEnvelopeSchema.parse(put?.body).value;
			return Response.json({ value: stored });
		}
	);
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await waitForFrame(setup, (frame) => frame.includes("llamacpp"));
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("0.6");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "s" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Could not save sampling defaults") &&
			frame.includes("503")
	);
	expect(putAttempts).toBe(1);
	await press(setup, { name: "s" });
	expect(putAttempts).toBe(2);
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);
	expect(putAttempts).toBe(2);
	const writes = requests.filter(
		(item) =>
			item.path === "/api/preferences/inference.engine.llamacpp" &&
			item.method === "PUT"
	);
	expect(writes.map((item) => item.body)).toEqual([
		{ value: '{"temperature":0.6}' },
		{ value: '{"temperature":0.6}' },
	]);
});

test("engine launch defaults save exact hardware and argument values and survive reopening Settings", async () => {
	const fixture = installLaunchCore();
	let setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await waitForFrame(setup, (frame) => frame.includes("Temperature (1/30)"));
	await press(setup, { name: "tab" });
	await waitForFrame(setup, (frame) => frame.includes("Context size (1/4)"));

	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("8192");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("8192"));

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("GPU layers (2/4)"));
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("-1");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) => frame.includes("Threads (3/4)"));
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("12");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });

	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Extra launch arguments (JSON array) (4/4)")
	);
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText('["--mlock","--no-mmap"]');
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);

	const launchPath = "/api/preferences/model.launch.engine.llamacpp";
	const writes = fixture.requests.filter(
		(item) => item.path === launchPath && item.method === "PUT"
	);
	expect(writes).toEqual([
		{
			body: {
				value:
					'{"ctx_size":8192,"gpu_layers":-1,"threads":12,"extra_args":["--mlock","--no-mmap"]}',
			},
			method: "PUT",
			path: launchPath,
		},
	]);
	expect(fixture.preferences.get("model.launch.engine.llamacpp")).toBe(
		'{"ctx_size":8192,"gpu_layers":-1,"threads":12,"extra_args":["--mlock","--no-mmap"]}'
	);
	expect(
		fixture.requests.filter(
			(item) => item.path === launchPath && item.method === "GET"
		).length
	).toBeGreaterThanOrEqual(2); // Initial read plus save readback.

	await act(async () => {
		setup.renderer.destroy();
		await Promise.resolve();
	});
	setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await press(setup, { name: "tab" });
	const reopened = await waitForFrame(
		setup,
		(frame) => frame.includes("Context size (1/4)") && frame.includes("8192")
	);
	expect(reopened).toContain("8192");
	for (let index = 0; index < 3; index += 1) {
		await press(setup, { name: "down" });
	}
	const reopenedArgs = await waitForFrame(setup, (frame) =>
		frame.includes('["--mlock","--no-mmap"]')
	);
	expect(reopenedArgs).toContain('["--mlock","--no-mmap"]');
});

test("Ollama, vLLM, SGLang, and MLX launch controls use their engine-specific Core preference keys", async () => {
	const fixture = installLaunchCore();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await waitForFrame(setup, (frame) => frame.includes("Engine llamacpp"));
	await press(setup, { name: "right" });
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Engine ollama"));
	await press(setup, { name: "tab" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Context size (1/3)") &&
			frame.includes("Modelfile PARAMETER num_ctx")
	);
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("8192");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);

	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Engine vllm"));
	await waitForFrame(setup, (frame) => frame.includes("Context size (1/4)"));
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("GPU memory utilization (2/4)")
	);
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("0.85");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);

	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Engine sglang"));
	await waitForFrame(setup, (frame) => frame.includes("Context size (1/4)"));
	await press(setup, { name: "down" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Memory fraction static (2/4)")
	);
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("0.8");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);

	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Engine mlx"));
	await waitForFrame(setup, (frame) =>
		frame.includes("Extra launch arguments (JSON array) (1/1)")
	);
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText('["--custom-launch-flag"]');
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);

	for (const [engine, expected] of [
		["ollama", { ctx_size: 8192 }],
		["vllm", { gpu_memory_utilization: 0.85 }],
		["sglang", { mem_fraction_static: 0.8 }],
		["mlx", { extra_args: ["--custom-launch-flag"] }],
	] as const) {
		const key = `model.launch.engine.${engine}`;
		expect(JSON.parse(fixture.preferences.get(key) ?? "null")).toEqual(
			expected
		);
		const write = fixture.requests.findLast(
			(item) => item.path === `/api/preferences/${key}` && item.method === "PUT"
		);
		expect(write).toBeDefined();
		expect(
			JSON.parse(preferenceEnvelopeSchema.parse(write?.body).value ?? "null")
		).toEqual(expected);
	}
});

test("launch validation blocks invalid hardware writes and launch reads/writes retry against the same preference", async () => {
	const fixture = installLaunchCore({
		"model.launch.engine.llamacpp": '{"ctx_size":4096}',
	});
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	fixture.failNextRead();
	await press(setup, { name: "tab" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not load launch defaults")
	);
	await press(setup, { name: "e" });
	await press(setup, { name: "s" });
	expect(
		fixture.requests.filter(
			(item) =>
				item.path === "/api/preferences/model.launch.engine.llamacpp" &&
				item.method === "PUT"
		).length
	).toBe(0);
	await press(setup, { name: "r" });
	await waitForFrame(
		setup,
		(frame) => frame.includes("Context size (1/4)") && frame.includes("4096")
	);

	await press(setup, { name: "down" });
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("-2");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("GPU layers must be at least -1.")
	);
	await press(setup, { name: "s" });
	expect(
		fixture.requests.filter(
			(item) =>
				item.path === "/api/preferences/model.launch.engine.llamacpp" &&
				item.method === "PUT"
		).length
	).toBe(0);

	await press(setup, { name: "tab" });
	await waitForFrame(setup, (frame) => frame.includes("Edit cancelled."));
	await press(setup, { name: "e" });
	await act(async () => {
		await setup.mockInput.typeText("-1");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	await press(setup, { name: "up" });
	await waitForFrame(setup, (frame) => frame.includes("Context size (1/4)"));
	await press(setup, { name: "e" });
	for (let index = 0; index < 4; index += 1) {
		await press(setup, { name: "backspace" });
	}
	await act(async () => {
		await setup.mockInput.typeText("6144");
	});
	await setup.flush({ maxPasses: 12 });
	await press(setup, { name: "return" });
	fixture.failNextWrite();
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Could not save launch defaults")
	);
	await press(setup, { name: "s" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Saved and confirmed from Core.")
	);
	const launchWrites = fixture.requests.filter(
		(item) =>
			item.path === "/api/preferences/model.launch.engine.llamacpp" &&
			item.method === "PUT"
	);
	expect(
		launchWrites.map((item) =>
			JSON.parse(preferenceEnvelopeSchema.parse(item.body).value)
		)
	).toEqual([
		{ ctx_size: 6144, gpu_layers: -1 },
		{ ctx_size: 6144, gpu_layers: -1 },
	]);
});

test("externally managed engines explain the launch boundary without reading or writing launch preferences", async () => {
	const fixture = installLaunchCore();
	const setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	testSetup = setup;
	await setup.renderOnce();
	await openInferenceSettings(setup);
	await waitForFrame(setup, (frame) => frame.includes("Engine llamacpp"));
	await press(setup, { name: "right" });
	await waitForFrame(setup, (frame) => frame.includes("Engine openai"));
	await press(setup, { name: "tab" });
	const boundary = await waitForFrame(setup, (frame) =>
		frame.includes("Ryu does not own this engine's model-launch process")
	);
	expect(boundary).toContain(
		"Per-model launch overrides have no editor in the CLI or Desktop yet."
	);
	expect(boundary).toContain("Settings");
	expect(boundary).toContain("Esc close");
	expect(boundary).toContain("General");
	// The Settings modal keeps a margin above it; find its top border row.
	const topBorder =
		boundary.split("\n").find((line) => line.includes("╭")) ?? "";
	expect(topBorder.indexOf("╭")).toBe(10);
	expect(topBorder.indexOf("╮")).toBe(129);
	expect(
		fixture.requests.some(
			(item) => item.path === "/api/preferences/model.launch.engine.openai"
		)
	).toBe(false);
	expect(
		fixture.requests.some((item) => item.path.includes("/launch-config"))
	).toBe(false);
	const proofPath = process.env.RYU_CLI_INFERENCE_BOUNDARY_PROOF;
	if (proofPath) {
		writeFileSync(`${proofPath}.svg`, renderTerminalSvg(setup.captureSpans()));
		writeFileSync(`${proofPath}.txt`, boundary);
		writeFileSync(
			`${proofPath}.requests.json`,
			JSON.stringify(fixture.requests, null, 2)
		);
	}
});
