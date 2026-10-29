/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-waitlist-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalNodeEnv === undefined) {
		Reflect.deleteProperty(process.env, "NODE_ENV");
	} else {
		process.env.NODE_ENV = originalNodeEnv;
	}
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
	}
	configDir = undefined;
});

async function waitFor(
	renderer: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	for (let pass = 0; pass < 30 && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
		frame = renderer.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Waitlist gate render did not match: ${frame}`);
	}
	return frame;
}

test("Waitlist gate r retries access and admits the CLI when Core approves the account", async () => {
	process.env.NODE_ENV = "production";
	let waitlistReads = 0;
	const provide = async (
		...args: Parameters<typeof realFetch>
	): ReturnType<typeof realFetch> => {
		const [input] = args;
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			// Core's /api/auth/status publisher always serializes all five fields.
			return Response.json({
				authenticated: true,
				pending: false,
				token: "test-token",
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/waitlist/me") {
			waitlistReads += 1;
			return Response.json({
				status: waitlistReads === 1 ? "pending" : "approved",
			});
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
	setup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const renderer = setup;
	const pending = await waitFor(renderer, (frame) =>
		frame.includes("You're on the waitlist")
	);
	expect(pending).toContain("r retry");
	await act(async () => {
		renderer.mockInput.pressKey("r");
	});
	await renderer.flush({ maxPasses: 12 });
	await waitFor(renderer, (frame) => frame.includes("Ask anything"));
	expect(waitlistReads).toBe(2);
});
