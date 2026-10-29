/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { App } from "../App.tsx";
import { testRender } from "./cli-test-render.ts";
import { MIN_TEXT_CONTRAST, renderedContrast } from "./color-contrast.ts";

interface SetupInstallationStates {
	[item: string]: string;
}

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

async function press(
	renderer: Awaited<ReturnType<typeof testRender>>,
	name: string,
	ctrl = false,
	shift = false
): Promise<void> {
	await act(async () => {
		renderer.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl,
				shift,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name.length === 1 ? name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await renderer.renderOnce();
}

async function waitForFrame(
	renderer: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	for (let pass = 0; pass < 35 && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
		frame = renderer.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Setup render did not match: ${frame}`);
	}
	return frame;
}

async function openSetupWizard(
	renderer: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
	await press(renderer, "k", true);
	for (const character of "setup") {
		await press(renderer, character);
	}
	await waitForFrame(renderer, (frame) => frame.includes("Go to Setup"));
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		(frame) => frame.includes("Dependencies") && frame.includes("git")
	);
	await renderer.flush({ maxPasses: 12 });
	await new Promise((resolve) => setTimeout(resolve, 0));
}

test("Setup filters catalog items by step and retries a failed provider install", async () => {
	let catalogReads = 0;
	let providerInstallAttempts = 0;
	const installs: string[] = [];
	const installStates: SetupInstallationStates = {
		ollama: "not_installed",
		"web-search": "not_installed",
		"acp-runtime": "not_installed",
	};
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const url = new URL(String(input));
			if (
				url.pathname === "/api/catalog" &&
				(init?.method ?? "GET") === "GET"
			) {
				catalogReads += 1;
				return Response.json({
					sidecars: [
						{
							name: "ollama",
							category: "provider",
							description: "Local inference",
							recommended: true,
							install_state: installStates.ollama,
						},
						{
							name: "web-search",
							category: "tool",
							description: "Search the web",
							install_state: installStates["web-search"],
						},
						{
							name: "acp-runtime",
							category: "agent",
							description: "Run ACP agents",
							install_state: installStates["acp-runtime"],
						},
					],
				});
			}
			if (url.pathname.startsWith("/api/setup/") && init?.method === "POST") {
				const item = url.pathname.split("/").at(-2) ?? "";
				installs.push(item);
				if (item === "ollama") {
					providerInstallAttempts += 1;
					if (providerInstallAttempts === 1) {
						return Response.json(
							{ error: "temporary failure" },
							{ status: 503 }
						);
					}
				}
				installStates[item] = "installed";
				return Response.json({ success: true });
			}
			return Response.json({});
		},
		{ preconnect: realFetch.preconnect }
	);
	setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const renderer = setup;
	await renderer.renderOnce();
	await openSetupWizard(renderer);
	// Inactive step labels are muted text, not the muted surface token.
	const wizardSpans = renderer.captureSpans();
	for (const label of ["2 Providers", "3 Tools", "4 Agents"]) {
		expect(renderedContrast(wizardSpans, label)).toBeGreaterThanOrEqual(
			MIN_TEXT_CONTRAST
		);
	}

	await press(renderer, "right");
	const providers = await waitForFrame(
		renderer,
		(frame) => frame.includes("ollama") && catalogReads > 0
	);
	expect(providers).toContain("Providers");
	expect(providers).not.toContain("web-search");
	expect(providers).not.toContain("acp-runtime");

	await press(renderer, "return");
	const failedInstall = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("error:") &&
			frame.includes("/api/setup/ollama/install failed: 503")
	);
	expect(failedInstall).toContain("ollama");
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await writeFile(
		path.join(EVIDENCE_DIR, "cli-setup-provider-install-retry-error.frame.txt"),
		failedInstall
	);
	const readsBeforeRetry = catalogReads;
	await press(renderer, "r");
	await waitForFrame(renderer, () => catalogReads > readsBeforeRetry);
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("installing ollama") && providerInstallAttempts === 2
	);
	await press(renderer, "r");
	const installedProvider = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("ollama installed") && !frame.includes("installing ollama")
	);
	expect(installedProvider).toContain("ollama installed");
	expect(installedProvider).not.toContain("installing ollama");
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await writeFile(
		path.join(EVIDENCE_DIR, "cli-setup-provider-installed.frame.txt"),
		installedProvider
	);

	await press(renderer, "tab");
	const tools = await waitForFrame(
		renderer,
		(frame) => frame.includes("web-search") && frame.includes("Search the web")
	);
	expect(tools).not.toContain("ollama");
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		() => installs.filter((name) => name === "web-search").length === 1
	);
	await press(renderer, "r");
	await waitForFrame(
		renderer,
		(frame) => frame.includes("web-search") && frame.includes("installed")
	);

	await press(renderer, "tab");
	const agents = await waitForFrame(
		renderer,
		(frame) => frame.includes("acp-runtime") && frame.includes("Run ACP agents")
	);
	expect(agents).not.toContain("web-search");
	await press(renderer, "return");
	await waitForFrame(
		renderer,
		() => installs.filter((name) => name === "acp-runtime").length === 1
	);
	await press(renderer, "r");
	await waitForFrame(
		renderer,
		(frame) => frame.includes("acp-runtime") && frame.includes("installed")
	);
	await press(renderer, "tab", false, true);
	await press(renderer, "tab", false, true);
	const cleanProviderState = await waitForFrame(
		renderer,
		(frame) =>
			frame.includes("[2 Providers]") &&
			frame.includes("ollama") &&
			frame.includes("installed")
	);
	expect(cleanProviderState).not.toContain("installing ollama");

	expect(installs).toEqual(["ollama", "ollama", "web-search", "acp-runtime"]);
});
