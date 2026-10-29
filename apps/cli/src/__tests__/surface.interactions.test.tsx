/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";

// Complete request emitted by the actual core-client runWorkflow publisher.
const workflowRunRequestFields = z.looseObject({
	input: z.record(z.string(), z.string()),
	dryRun: z.literal(true).optional(),
});
type WorkflowRunRequestObservation = z.infer<typeof workflowRunRequestFields>;
const workflowRunRequestObservationSchema =
	z.custom<WorkflowRunRequestObservation>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			workflowRunRequestFields.safeParse(value).success
	);
interface RunRequestObservation {
	body: WorkflowRunRequestObservation;
	url: string;
}

const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | undefined;
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-contributed-command-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});

function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

function hasConsoleMode(frame: string): boolean {
	return frame
		.split("\n")
		.some(
			(line) =>
				line.includes("Ryu") && line.includes("Agent") && line.includes("⌄")
		);
}

afterEach(async () => {
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	globalThis.fetch = realFetch;
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
		configDir = undefined;
	}
});

function resetConsoleLanding(): void {
	const home = process.env.USERPROFILE || process.env.HOME || ".";
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(home)
	);
}

interface KeyOverride {
	ctrl?: boolean;
	name: string;
	shift?: boolean;
}

async function press(
	setup: Awaited<ReturnType<typeof testRender>>,
	key: KeyOverride
): Promise<void> {
	await frameSatisfying(setup, hasConsoleMode);
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: key.shift ?? false,
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

async function frameSatisfying(
	setup: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < 30 && !predicate(frame); pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
			frame = setup.captureCharFrame();
		});
	}
	if (!predicate(frame)) {
		throw new Error(`Surface render did not match: ${frame}`);
	}
	return frame;
}

async function openPaletteRoute(
	setup: Awaited<ReturnType<typeof testRender>>,
	query: string
): Promise<void> {
	await press(setup, { name: "k", ctrl: true });
	for (const character of query) {
		await press(setup, { name: character });
	}
	await press(setup, { name: "return" });
}

test(
	"Home quick actions open each advertised surface and refresh system status",
	async () => {
		let statusRequests = 0;
		installResponse(async (input) => {
			const url = String(input);
			let body: z.infer<typeof appRequestValueSchema> = {};
			if (url.endsWith("/api/system/status")) {
				statusRequests += 1;
				body = { sidecars: [], gateway: {}, engine: {} };
			} else if (url.split("?")[0].endsWith("/heartbeat/jobs")) {
				// The list opts in to app jobs (`?include=app_jobs`).
				body = { jobs: [] };
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const actions = [
			{ name: "New chat", keypresses: 0, marker: "route auto" },
			{ name: "Library", keypresses: 1, marker: "recipes ·" },
			{ name: "Tasks", keypresses: 2, marker: "scheduled jobs" },
			{ name: "Calendar", keypresses: 3, marker: "agenda" },
			{ name: "Timeline", keypresses: 4, marker: "activity history" },
			{ name: "Monitors", keypresses: 5, marker: "Monitors" },
		];
		for (const [actionIndex, action] of actions.entries()) {
			const requestsBeforeLaunch = statusRequests;
			resetConsoleLanding();
			testSetup = await testRender(<App target={LOCAL_TARGET} />, {
				width: 140,
				height: 36,
			});
			const setup = testSetup;
			await frameSatisfying(setup, hasConsoleMode);
			await openPaletteRoute(setup, "home");
			await frameSatisfying(setup, (frame) => frame.includes("Quick actions"));
			await frameSatisfying(setup, () => statusRequests > requestsBeforeLaunch);
			await setup.flush({ maxPasses: 12 });
			if (actionIndex === 0) {
				await press(setup, { name: "k" });
				expect(setup.captureCharFrame()).toContain("› New chat");
				await press(setup, { name: "up" });
				expect(setup.captureCharFrame()).toContain("› New chat");
				await press(setup, { name: "r" });
				await frameSatisfying(
					setup,
					() => statusRequests > requestsBeforeLaunch + 1
				);
			}
			if (action.keypresses > 0) {
				for (let step = 0; step < action.keypresses; step += 1) {
					await press(setup, { name: step % 2 === 0 ? "down" : "j" });
				}
			}
			await press(setup, { name: "return" });
			await frameSatisfying(setup, (frame) => frame.includes(action.marker));
			await act(async () => {
				setup.renderer.destroy();
			});
			testSetup = null;
		}
	},
	{ timeout: 15_000 }
);

test("Setup arrows and Tab keys move among all wizard steps in both directions", async () => {
	installResponse(
		async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})
	);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await openPaletteRoute(setup, "setup");
	await frameSatisfying(setup, (frame) => frame.includes("[1 Dependencies]"));

	for (const title of ["Providers", "Tools", "Agents"]) {
		await press(setup, { name: "right" });
		await frameSatisfying(setup, (frame) => frame.includes(title));
	}
	await press(setup, { name: "right" });
	expect(setup.captureCharFrame()).toContain("[4 Agents]");
	await press(setup, { name: "tab", shift: true });
	await frameSatisfying(setup, (frame) => frame.includes("[3 Tools]"));
	await press(setup, { name: "left" });
	await frameSatisfying(setup, (frame) => frame.includes("[2 Providers]"));
	await press(setup, { name: "left" });
	await frameSatisfying(setup, (frame) => frame.includes("[1 Dependencies]"));
});

test("Workflows require confirmation, Escape cancels, and Enter starts the selected run", async () => {
	const runRequests: RunRequestObservation[] = [];
	let workflowListReads = 0;
	installResponse(async (input, init) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/workflows") && init?.method !== "POST") {
			workflowListReads += 1;
			body = {
				workflows: [
					{ id: "wf-1", name: "Nightly build" },
					{ id: "wf-2", name: "Nightly package" },
				],
			};
		} else if (url.endsWith("/workflows/wf-1/run")) {
			runRequests.push({
				body: workflowRunRequestObservationSchema.parse(
					JSON.parse(String(init?.body))
				),
				url,
			});
			body = {
				run: {
					run_id: "run-1",
					workflow_id: "wf-1",
					status: "completed",
					created_at: "2026-09-24T00:00:00Z",
					updated_at: "2026-09-24T00:00:00Z",
					output: { result: "built" },
				},
			};
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await openPaletteRoute(setup, "workflows");
	await frameSatisfying(
		setup,
		(frame) =>
			frame.includes("Nightly build") &&
			frame.includes("select a workflow and press enter to run it")
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await setup.flush({ maxPasses: 12 });
	const previousWorkflowReads = workflowListReads;
	await press(setup, { name: "r" });
	await frameSatisfying(setup, () => workflowListReads > previousWorkflowReads);
	await press(setup, { name: "down" });
	await frameSatisfying(setup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Nightly package"))
	);
	await press(setup, { name: "up" });
	await frameSatisfying(setup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Nightly build"))
	);
	await press(setup, { name: "down" });
	await frameSatisfying(setup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Nightly package"))
	);
	await press(setup, { name: "k" });
	await frameSatisfying(setup, (frame) =>
		frame
			.split("\n")
			.some((row) => row.includes("›") && row.includes("Nightly build"))
	);
	await press(setup, { name: "j" });
	await press(setup, { name: "return" });
	await frameSatisfying(setup, (frame) =>
		frame.includes("Press enter to confirm run")
	);
	await press(setup, { name: "escape" });
	await frameSatisfying(setup, (frame) =>
		frame.includes("select a workflow and press enter to run it")
	);
	await press(setup, { name: "k" });

	await press(setup, { name: "return" });
	await frameSatisfying(setup, (frame) =>
		frame.includes("Press enter to confirm run")
	);
	await press(setup, { name: "escape" });
	await frameSatisfying(setup, (frame) =>
		frame.includes("select a workflow and press enter to run it")
	);
	expect(runRequests).toEqual([]);

	await press(setup, { name: "return" });
	await frameSatisfying(setup, (frame) =>
		frame.includes("Press enter to confirm run")
	);
	await press(setup, { name: "return" });
	const completed = await frameSatisfying(
		setup,
		(frame) => frame.includes("completed") && frame.includes("result: built")
	);
	expect(completed).toContain("result: built");
	expect(runRequests.at(-1)).toEqual({
		body: { input: {} },
		url: `${LOCAL_TARGET.url}/workflows/wf-1/run`,
	});
});

test("Spaces move between document lists, refresh cached documents, and page history", async () => {
	let betaDocumentReads = 0;
	const conversations = Array.from({ length: 20 }, (_, index) => ({
		id: `conversation-${index + 1}`,
		title: `History ${index + 1}`,
		message_count: index + 1,
		updated_at: `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
	}));
	installResponse(async (input) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/spaces")) {
			body = {
				spaces: [
					{
						id: "space-alpha",
						name: "Alpha space",
						document_count: 1,
						created_at: 1,
						updated_at: 1,
					},
					{
						id: "space-beta",
						name: "Beta space",
						document_count: 1,
						created_at: 1,
						updated_at: 1,
					},
				],
			};
		} else if (url.endsWith("/api/spaces/space-alpha/documents")) {
			body = {
				documents: [
					{
						id: "doc-alpha",
						space_id: "space-alpha",
						title: "Alpha document",
						chunk_count: 2,
						created_at: 1,
					},
				],
			};
		} else if (url.endsWith("/api/spaces/space-beta/documents")) {
			betaDocumentReads += 1;
			body = {
				documents: [
					{
						id: "doc-beta",
						space_id: "space-beta",
						title: `Beta document ${betaDocumentReads}`,
						chunk_count: 3,
						created_at: 1,
					},
				],
			};
		} else if (url.endsWith("/api/conversations")) {
			body = { conversations };
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 160,
		height: 40,
	});
	const setup = testSetup;
	await openPaletteRoute(setup, "spaces");
	await frameSatisfying(setup, (frame) => frame.includes("Alpha document"));
	await press(setup, { name: "down" });
	await frameSatisfying(setup, (frame) => frame.includes("Beta document 1"));
	expect(betaDocumentReads).toBe(1);
	await press(setup, { name: "k" });
	await frameSatisfying(setup, (frame) => frame.includes("Alpha document"));
	await press(setup, { name: "up" });
	await frameSatisfying(setup, (frame) => frame.includes("Alpha document"));
	await press(setup, { name: "j" });
	await frameSatisfying(setup, (frame) => frame.includes("Beta document 1"));
	await press(setup, { name: "pagedown" });
	expect(
		await frameSatisfying(setup, (frame) => frame.includes("7-20/20"))
	).toContain("7-20/20");
	await press(setup, { name: "pageup" });
	expect(
		await frameSatisfying(setup, (frame) => frame.includes("1-14/20"))
	).toContain("1-14/20");

	await press(setup, { name: "r" });
	const refreshed = await frameSatisfying(setup, (frame) =>
		frame.includes("Beta document 2")
	);
	expect(refreshed).toContain("Beta document 2");
	expect(betaDocumentReads).toBe(2);
});

test("Timeline r rechecks Shadow status on the active node", async () => {
	let statusReads = 0;
	installResponse(async (input) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/system/status")) {
			statusReads += 1;
			body = { sidecars: [], gateway: {}, engine: {} };
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 140,
		height: 36,
	});
	const setup = testSetup;
	await openPaletteRoute(setup, "timeline");
	await frameSatisfying(setup, (frame) => frame.includes("activity history"));
	await frameSatisfying(setup, () => statusReads >= 1);
	await press(setup, { name: "r" });
	await frameSatisfying(setup, () => statusReads >= 2);
	expect(statusReads).toBe(2);
});
