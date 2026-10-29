import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GamingSettings,
	StreamingSettings,
} from "@/src/lib/api/presence.ts";

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Real HTTP and React commits take an unbounded time on a loaded machine, so
// `settle()` waits for the client's outstanding requests rather than a fixed
// interval. Writes a test deliberately holds open are excluded.
let clientInflight = 0;
let heldRequests = 0;
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		clientInflight += 1;
		try {
			return await nativeFetch(...args);
		} finally {
			clientInflight -= 1;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node: ApiTarget;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
const { createRoot } = await import("react-dom/client");
const { AvailabilitySettings } = await import("./AvailabilitySettings.tsx");
interface Call {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	userJwt: string | null;
}
let calls: Call[];
let gaming: GamingSettings;
let streaming: StreamingSettings;
let refuse = false;
let deferWrites = false;
let releases: Array<() => void> = [];
let server: ReturnType<typeof Bun.serve>;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	calls = [];
	gaming = {
		detectionEnabled: true,
		freeLocalModels: true,
		extraProcesses: ["hades"],
		ignoredProcesses: ["obs64"],
	};
	streaming = { detectionEnabled: true, apps: ["obs64"], schemaVersion: 1 };
	refuse = false;
	deferWrites = false;
	releases = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const call: Call = {
				path,
				method: request.method,
				authorization: request.headers.get("authorization"),
				userJwt: request.headers.get("x-ryu-user-jwt"),
				body: request.method === "PUT" ? await request.json() : null,
			};
			calls.push(call);
			if (request.method === "PUT") {
				if (deferWrites) {
					heldRequests += 1;
					try {
						await new Promise<void>((resolve) => releases.push(resolve));
					} finally {
						heldRequests -= 1;
					}
				}
				if (refuse) {
					return NativeResponse.json(
						{ error: "Permission denied" },
						{ status: 403 }
					);
				}
				if (path.endsWith("gaming")) {
					gaming = call.body as GamingSettings;
				} else {
					streaming = call.body as StreamingSettings;
				}
			}
			if (call.authorization === "Bearer other-node-token") {
				return NativeResponse.json(
					path.endsWith("gaming")
						? {
								detectionEnabled: true,
								freeLocalModels: false,
								extraProcesses: ["other-game"],
								ignoredProcesses: [],
							}
						: {
								detectionEnabled: true,
								apps: ["other-streamer"],
								schemaVersion: 1,
							}
				);
			}
			return NativeResponse.json(path.endsWith("gaming") ? gaming : streaming);
		},
	});
	node = {
		url: server.url.toString().replace(/\/$/, ""),
		token: "selected-node-token",
		userJwt: "managed-user-identity",
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	for (const release of releases) {
		release();
	}
	await act(async () => root.unmount());
	container.remove();
	server.stop(true);
});
async function settle() {
	const deadline = Date.now() + 3000;
	do {
		await act(async () => {
			await Bun.sleep(25);
		});
	} while (clientInflight > heldRequests && Date.now() < deadline);
}
async function mount() {
	await act(async () => root.render(<AvailabilitySettings />));
	await settle();
}
function input(id: string) {
	const element = container.querySelector<HTMLInputElement>(`#${id}`);
	if (!element) {
		throw new Error(`Missing ${id}`);
	}
	return element;
}
function toggle(id: string) {
	const element =
		input(id).parentElement?.querySelector<HTMLElement>('[role="switch"]');
	if (!element) {
		throw new Error(`Missing ${id}`);
	}
	return element;
}
async function click(id: string) {
	await act(async () => toggle(id).click());
	await settle();
}
async function edit(id: string, value: string) {
	const element = input(id);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () =>
		element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
	);
	await settle();
}
function writes() {
	return calls.filter((call) => call.method === "PUT");
}
async function remount() {
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
}

for (const [id, field] of [
	["availability-gaming-detection-toggle", "detectionEnabled"],
	["availability-gaming-free-models-toggle", "freeLocalModels"],
] as const) {
	test(`${field} saves its gaming flag with selected-node authorization and reads back after remount`, async () => {
		await mount();
		const previous = { ...gaming };
		await click(id);
		expect(writes()).toEqual([
			{
				path: "/api/presence/gaming",
				method: "PUT",
				authorization: "Bearer selected-node-token",
				userJwt: "managed-user-identity",
				body: { ...previous, [field]: false },
			},
		]);
		await remount();
		expect(toggle(id).hasAttribute("data-checked")).toBe(false);
		if (field === "detectionEnabled") {
			expect(input("availability-gaming-processes-input").disabled).toBe(true);
			expect(input("availability-gaming-ignored-input").disabled).toBe(true);
		}
	});
}
for (const [id, field] of [
	["availability-gaming-processes-input", "extraProcesses"],
	["availability-gaming-ignored-input", "ignoredProcesses"],
] as const) {
	test(`${field} trims separators, drops empty entries and persists without changing other controls`, async () => {
		await mount();
		const previous = { ...gaming };
		await edit(id, " first-game , , second-game , ");
		expect(writes()[0]?.body).toEqual({
			...previous,
			[field]: ["first-game", "second-game"],
		});
		await remount();
		expect(input(id).value).toBe("first-game, second-game");
		await edit(id, "first-game, second-game");
		expect(writes()).toHaveLength(1);
		await edit(id, " , , ");
		expect(writes()[1]?.body).toEqual({ ...previous, [field]: [] });
		await remount();
		expect(input(id).value).toBe("");
	});
}
test("streaming detection off disables executable edits, survives remount, and can be re-enabled", async () => {
	await mount();
	await click("availability-streaming-detection-toggle");
	expect(writes()[0]).toEqual({
		path: "/api/presence/streaming",
		method: "PUT",
		authorization: "Bearer selected-node-token",
		userJwt: "managed-user-identity",
		body: { apps: ["obs64"], detectionEnabled: false, schemaVersion: 1 },
	});
	expect(input("availability-streaming-apps-input").disabled).toBe(true);
	await remount();
	expect(
		toggle("availability-streaming-detection-toggle").hasAttribute(
			"data-checked"
		)
	).toBe(false);
	await click("availability-streaming-detection-toggle");
	expect(input("availability-streaming-apps-input").disabled).toBe(false);
	expect(streaming.detectionEnabled).toBe(true);
});
test("streaming apps trim separators and persist without touching gaming settings", async () => {
	await mount();
	const previousGaming = { ...gaming };
	await edit(
		"availability-streaming-apps-input",
		" OBS64.exe , , Streamlabs Desktop.exe  , "
	);
	expect(writes()[0]?.body).toEqual({
		apps: ["OBS64.exe", "Streamlabs Desktop.exe"],
		detectionEnabled: true,
		schemaVersion: 1,
	});
	expect(writes()[0]?.path).toBe("/api/presence/streaming");
	expect(gaming).toEqual(previousGaming);
	await remount();
	expect(input("availability-streaming-apps-input").value).toBe(
		"OBS64.exe, Streamlabs Desktop.exe"
	);
});
test("rejected gaming and streaming toggles roll back and permit retry", async () => {
	await mount();
	refuse = true;
	await click("availability-gaming-free-models-toggle");
	await click("availability-streaming-detection-toggle");
	expect(
		toggle("availability-gaming-free-models-toggle").hasAttribute(
			"data-checked"
		)
	).toBe(true);
	expect(
		toggle("availability-streaming-detection-toggle").hasAttribute(
			"data-checked"
		)
	).toBe(true);
	expect(gaming.freeLocalModels).toBe(true);
	expect(streaming.detectionEnabled).toBe(true);
	refuse = false;
	await click("availability-gaming-free-models-toggle");
	await click("availability-streaming-detection-toggle");
	expect(gaming.freeLocalModels).toBe(false);
	expect(streaming.detectionEnabled).toBe(false);
});
test("a rejected process-list save restores the field rather than leaving an unsaved draft looking persisted", async () => {
	await mount();
	refuse = true;
	await edit("availability-gaming-processes-input", "never-saved");
	expect(gaming.extraProcesses).toEqual(["hades"]);
	expect(input("availability-gaming-processes-input").value).toBe("hades");
});

for (const [id, dependentInput] of [
	[
		"availability-gaming-detection-toggle",
		"availability-gaming-processes-input",
	],
	[
		"availability-streaming-detection-toggle",
		"availability-streaming-apps-input",
	],
] as const) {
	test(`${id} prevents a second preference write while its save is pending`, async () => {
		await mount();
		deferWrites = true;
		await click(id);
		expect(writes()).toHaveLength(1);
		expect(toggle(id).hasAttribute("data-disabled")).toBe(true);
		expect(input(dependentInput).disabled).toBe(true);
		await click(id);
		expect(writes()).toHaveLength(1);
		deferWrites = false;
		for (const release of releases.splice(0)) {
			release();
		}
		await settle();
		expect(toggle(id).hasAttribute("data-disabled")).toBe(false);
		await click(id);
		expect(writes()).toHaveLength(2);
	});
}

for (const [id, listId, expectedList] of [
	[
		"availability-gaming-detection-toggle",
		"availability-gaming-processes-input",
		"other-game",
	],
	[
		"availability-streaming-detection-toggle",
		"availability-streaming-apps-input",
		"other-streamer",
	],
] as const) {
	test(`${id} cannot replace another credential scope with its old pending save`, async () => {
		await mount();
		deferWrites = true;
		await click(id);
		node = { ...node, token: "other-node-token", userJwt: "other-user" };
		await mount();
		expect(input(listId).value).toBe(expectedList);
		expect(toggle(id).hasAttribute("data-checked")).toBe(true);
		deferWrites = false;
		for (const release of releases.splice(0)) {
			release();
		}
		await settle();
		expect(input(listId).value).toBe(expectedList);
		expect(toggle(id).hasAttribute("data-checked")).toBe(true);
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.authorization).toBe("Bearer selected-node-token");
	});
}

test("without secure-context randomUUID, settings render and changing authority discards both unsaved process lists", async () => {
	const uuidDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
	Object.defineProperty(crypto, "randomUUID", {
		configurable: true,
		value: undefined,
	});
	try {
		await mount();
		for (const id of [
			"availability-gaming-processes-input",
			"availability-streaming-apps-input",
		]) {
			await act(async () => {
				const element = input(id);
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value"
				)?.set?.call(element, "unsaved-private-process");
				element.dispatchEvent(new Event("input", { bubbles: true }));
			});
			expect(input(id).value).toBe("unsaved-private-process");
		}
		node = { ...node, token: "other-node-token", userJwt: "other-user" };
		await mount();
		expect(input("availability-gaming-processes-input").value).toBe(
			"other-game"
		);
		expect(input("availability-streaming-apps-input").value).toBe(
			"other-streamer"
		);
		expect(writes()).toHaveLength(0);
		expect(
			calls.filter(
				(call) =>
					call.authorization === "Bearer other-node-token" &&
					call.method === "GET"
			)
		).toHaveLength(2);
	} finally {
		if (uuidDescriptor) {
			Object.defineProperty(crypto, "randomUUID", uuidDescriptor);
		} else {
			Reflect.deleteProperty(crypto, "randomUUID");
		}
	}
});
