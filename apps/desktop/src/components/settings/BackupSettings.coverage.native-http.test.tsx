import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping node backup settings (the S3 section the Storage and
// Spaces tabs render) against an owned native HTTP peer that serves two node
// authorities and enforces Core's destination contract: unknown fields are
// rejected (`deny_unknown_fields`) and allowed app IDs must match Core's own
// rule (`crates/core/backup/src/s3.rs`). Every request is a genuine HTTP
// exchange through the shipping clients.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDom) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Owner = "a" | "b";
interface Call {
	body: unknown;
	method: string;
	owner: Owner | null;
	path: string;
	status: number;
}
interface Destination {
	allowedApps: string[];
	allowHttp: boolean;
	bucket: string;
	createdAt: string;
	endpoint: string;
	id: string;
	name: string;
	pathStyle: boolean;
	prefix: string;
	region: string;
}

const SAVE_FIELDS = new Set([
	"name",
	"endpoint",
	"bucket",
	"region",
	"prefix",
	"pathStyle",
	"allowHttp",
	"allowedApps",
	"accessKeyId",
	"secretAccessKey",
	"sessionToken",
	"recoveryKey",
]);
const APP_ID = /^[A-Za-z0-9.\-_@/]{1,128}$/;
const RECOVERY_KEY = "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c=";
const calls: Call[] = [];
const unknown: string[] = [];
const runtimeErrors: string[] = [];
const destinations: Record<Owner, Destination[]> = { a: [], b: [] };
let pending = 0;

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		pending += 1;
		try {
			const url = new URL(request.url);
			const prefix = url.pathname.split("/")[1];
			const owner: Owner | null =
				prefix === "a" || prefix === "b" ? prefix : null;
			const path = owner ? url.pathname.slice(owner.length + 1) : url.pathname;
			const raw = await request.text();
			const call: Call = {
				owner,
				method: request.method,
				path,
				body: raw === "" ? null : JSON.parse(raw),
				status: 0,
			};
			calls.push(call);
			const reply = (body: unknown, status = 200) => {
				call.status = status;
				return NativeResponse.json(body, { status });
			};
			if (
				!owner ||
				request.headers.get("authorization") !== `Bearer backup-${owner}-token`
			) {
				unknown.push(`${request.method} ${url.pathname}: wrong authority`);
				return reply({ error: "Wrong node authority" }, 403);
			}
			if (request.method === "GET" && path === "/api/spaces") {
				return reply({ spaces: [] });
			}
			if (request.method === "GET" && path === "/api/backups") {
				return reply({
					destinations: destinations[owner],
					operations: [],
					policies: [],
				});
			}
			if (request.method === "POST" && path === "/api/backups/recovery-key") {
				return reply({ recoveryKey: RECOVERY_KEY });
			}
			const editing = path.match(/^\/api\/backups\/destinations\/([^/]+)$/);
			if (
				(request.method === "POST" && path === "/api/backups/destinations") ||
				(request.method === "PUT" && editing)
			) {
				const body = call.body as Record<string, unknown>;
				const extra = Object.keys(body).filter((key) => !SAVE_FIELDS.has(key));
				if (extra.length > 0) {
					return reply({ error: `unknown field ${extra[0]}` }, 422);
				}
				const apps = body.allowedApps;
				if (
					!Array.isArray(apps) ||
					apps.length > 100 ||
					!apps.every((app) => typeof app === "string" && APP_ID.test(app))
				) {
					return reply({ error: "Invalid allowed app IDs" }, 400);
				}
				const id =
					editing?.[1] ??
					`${owner}-destination-${destinations[owner].length + 1}`;
				const previous = destinations[owner].find((entry) => entry.id === id);
				const saved: Destination = {
					id,
					name: String(body.name),
					endpoint: previous?.endpoint ?? String(body.endpoint),
					bucket: previous?.bucket ?? String(body.bucket),
					region: String(body.region),
					prefix: previous?.prefix ?? String(body.prefix ?? ""),
					pathStyle: body.pathStyle !== false,
					allowHttp: body.allowHttp === true,
					allowedApps: apps,
					createdAt: "2026-10-11T08:00:00.000Z",
				};
				destinations[owner] = previous
					? destinations[owner].map((entry) =>
							entry.id === id ? saved : entry
						)
					: [...destinations[owner], saved];
				return reply(saved);
			}
			unknown.push(`${request.method} ${path}`);
			return reply({ error: "Undeclared backup contract" }, 404);
		} finally {
			pending -= 1;
		}
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { NodeBackupSettings } = await import("./BackupSettings.tsx");

const previousNodes = useNodeStore.getState();
const base = server.url.toString().replace(/\/$/, "");
let root: ReturnType<typeof createRoot> | null = null;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

async function idle() {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function select(owner: Owner) {
	const node = {
		...LOCAL_FALLBACK,
		name: `backup-${owner}`,
		url: `${base}/${owner}`,
		token: `backup-${owner}-token`,
		userJwt: null,
	};
	await act(async () => {
		useNodeStore.setState({
			defaultNode: node.name,
			nodes: [node],
			localNodes: [node],
			cloudNodes: [],
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		});
	});
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () => root?.render(createElement(NodeBackupSettings)));
	await until(
		() => !text().includes("Loading backup settings…"),
		"Backup overview did not load"
	);
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
}
function text() {
	return document.body.textContent ?? "";
}
function dialog(): HTMLElement | null {
	const found = document.body.querySelector('[role="dialog"]');
	return found instanceof HTMLElement ? found : null;
}
function requireDialog(): HTMLElement {
	const found = dialog();
	if (!found) {
		throw new Error("The destination dialog is not open");
	}
	return found;
}
function maybeButton(name: string, scope: ParentNode = document.body) {
	return [...scope.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name
	);
}
function button(name: string, scope: ParentNode = document.body) {
	const found = maybeButton(name, scope);
	if (!found) {
		throw new Error(`Missing backup action ${name}`);
	}
	return found;
}
function field(label: string): HTMLInputElement {
	const labelElement = [...requireDialog().querySelectorAll("label")].find(
		(item) => item.textContent?.trim() === label
	);
	const input = labelElement?.htmlFor
		? document.getElementById(labelElement.htmlFor)
		: null;
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`Missing field ${label}`);
	}
	return input;
}
async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function confirmKeySaved() {
	const label = [...requireDialog().querySelectorAll("label")].find((item) =>
		item.textContent?.includes("I have saved my recovery key")
	);
	if (!label) {
		throw new Error("Missing the saved-key confirmation");
	}
	await act(async () => label.click());
}
async function submit() {
	await act(async () => button("Validate & save", requireDialog()).click());
}
function destinationSaves(owner: Owner) {
	return calls.filter(
		(call) =>
			call.owner === owner &&
			call.path.startsWith("/api/backups/destinations") &&
			call.method !== "GET"
	);
}

beforeEach(async () => {
	calls.length = 0;
	unknown.length = 0;
	runtimeErrors.length = 0;
	destinations.a = [];
	destinations.b = [];
	queryClient.clear();
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
	await select("a");
});
afterEach(async () => {
	await unmount();
	await idle();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	const violations = [
		pending === 0 ? null : `${pending} native exchanges still pending`,
		unknown.length === 0 ? null : `undeclared requests: ${unknown.join("; ")}`,
		runtimeErrors.length === 0
			? null
			: `runtime errors: ${runtimeErrors.join("; ")}`,
	].filter((violation) => violation !== null);
	if (violations.length > 0) {
		throw new Error(`Backup case closure failed: ${violations.join(" | ")}`);
	}
});
afterAll(async () => {
	queryClient.clear();
	useNodeStore.setState(previousNodes);
	await server.stop(true);
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("the approved-apps field sends trimmed IDs without blanks, keeps the draft when Core rejects an ID, and the saved list survives an independent reload and an edit that clears it", async () => {
	await mount();
	expect(text()).toContain("No S3 destinations yet");
	await act(async () => button("Add destination").click());
	const apps = field("Apps allowed to use this destination");
	expect(apps.placeholder).toBe("@ryu/canvas, com.example.myapp");
	await type(field("Destination name"), "Nightly archive");
	await type(field("S3 endpoint"), "https://s3.us-east-1.amazonaws.com");
	await type(field("Bucket"), "ryu-coverage-backups");
	await type(field("Access key ID"), "AKIACOVERAGE");
	await type(field("Secret access key"), "coverage-secret");
	await act(async () => button("Generate key", requireDialog()).click());
	await until(
		() => field("Recovery key").value === RECOVERY_KEY,
		"Generated recovery key was not filled in"
	);
	await confirmKeySaved();
	await type(apps, "  @ryu/canvas , com.example.myapp,, bad id!  ");
	await submit();
	await until(
		() =>
			requireDialog().querySelector('[role="alert"]')?.textContent ===
			"Invalid allowed app IDs",
		"Core's rejection was not shown in the dialog"
	);
	expect(destinationSaves("a").map((call) => call.body)).toEqual([
		expect.objectContaining({
			allowedApps: ["@ryu/canvas", "com.example.myapp", "bad id!"],
		}),
	]);
	// The draft is kept for correction, including every other field.
	expect(field("Apps allowed to use this destination").value).toBe(
		"  @ryu/canvas , com.example.myapp,, bad id!  "
	);
	expect(field("Destination name").value).toBe("Nightly archive");
	expect(destinations.a).toEqual([]);

	await type(
		field("Apps allowed to use this destination"),
		"@ryu/canvas, com.example.myapp, "
	);
	await submit();
	await until(
		() => dialog() === null,
		"Saved destination dialog did not close"
	);
	const accepted = destinationSaves("a")[1];
	expect(accepted?.status).toBe(200);
	expect(accepted?.body).toMatchObject({
		name: "Nightly archive",
		bucket: "ryu-coverage-backups",
		allowedApps: ["@ryu/canvas", "com.example.myapp"],
		recoveryKey: RECOVERY_KEY,
	});
	await until(
		() => text().includes("2 approved apps"),
		"The saved destination did not list its approved apps"
	);

	// An independent reload reads what the node stored.
	await unmount();
	queryClient.clear();
	await mount();
	expect(text()).toContain("Nightly archive");
	expect(text()).toContain("2 approved apps");

	await act(async () => button("Edit").click());
	expect(field("Apps allowed to use this destination").value).toBe(
		"@ryu/canvas, com.example.myapp"
	);
	await type(field("Access key ID"), "AKIACOVERAGE");
	await type(field("Secret access key"), "coverage-secret");
	await type(field("Recovery key"), RECOVERY_KEY);
	await confirmKeySaved();
	await type(field("Apps allowed to use this destination"), " , ");
	await submit();
	await until(
		() => dialog() === null,
		"Edited destination dialog did not close"
	);
	const edit = destinationSaves("a").at(-1);
	expect(edit?.method).toBe("PUT");
	expect(edit?.path).toBe("/api/backups/destinations/a-destination-1");
	expect(edit?.body).toMatchObject({ allowedApps: [] });
	await until(
		() => text().includes("No app access"),
		"Clearing the approved apps was not reflected"
	);
	expect(destinations.a[0]?.allowedApps).toEqual([]);
	expect(calls.filter((call) => call.owner === "b")).toEqual([]);
});

test("an approved-apps draft belongs to the node it was typed for: selecting another node discards it, and a destination saved afterwards is created on the selected node only", async () => {
	await mount();
	await act(async () => button("Add destination").click());
	await type(field("Apps allowed to use this destination"), "@ryu/canvas");
	await type(field("Destination name"), "Node A archive");
	await select("b");
	await until(
		() => dialog() === null && text().includes("No S3 destinations yet"),
		"Selecting node B did not retire node A's draft"
	);
	expect(destinationSaves("a")).toEqual([]);
	await act(async () => button("Add destination").click());
	expect(field("Apps allowed to use this destination").value).toBe("");
	expect(field("Destination name").value).toBe("");
	await type(field("Destination name"), "Node B archive");
	await type(field("S3 endpoint"), "https://r2.example.com");
	await type(field("Bucket"), "ryu-b");
	await type(field("Access key ID"), "AKIAB");
	await type(field("Secret access key"), "b-secret");
	await type(field("Recovery key"), RECOVERY_KEY);
	await confirmKeySaved();
	await type(
		field("Apps allowed to use this destination"),
		"com.example.notes"
	);
	await submit();
	await until(() => dialog() === null, "Node B destination did not save");
	expect(destinations.b.map((entry) => entry.allowedApps)).toEqual([
		["com.example.notes"],
	]);
	expect(destinations.a).toEqual([]);
	expect(destinationSaves("a")).toEqual([]);
	await until(
		() => text().includes("1 approved app"),
		"Node B destination did not list its approved app"
	);
});
