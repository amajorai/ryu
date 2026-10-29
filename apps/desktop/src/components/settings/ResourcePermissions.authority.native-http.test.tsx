// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { z } from "zod";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

// Source-only proposal. This mounts the shipping editor, active-node hook,
// identity headers, HTTP decoder, UI primitives and Toaster without replacing
// a business module. The invocation owns only its external native HTTP peer.
// Its atomic physical receipt is not Core's ACL store or authorization engine.
const nativeFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTextEncoder = globalThis.TextEncoder;
const nativeResponseText = NativeResponse.prototype.text;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
const domAbortController = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortController"
);
const domAbortSignal = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortSignal"
);
Object.defineProperty(globalThis, "AbortController", {
	configurable: true,
	writable: true,
	value: NativeAbortController,
});
Object.defineProperty(globalThis, "AbortSignal", {
	configurable: true,
	writable: true,
	value: NativeAbortSignal,
});
const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const resourceId = "agent:permissions Ω";
const otherResourceId = "agent:untouched";
const resourcePath = `/api/acl/resources/agent/${encodeURIComponent(resourceId)}`;
const otherResourcePath = `/api/acl/resources/agent/${encodeURIComponent(otherResourceId)}`;
// The same identifier under a different resource kind is a different ACL
// record. Its physical key keeps the kind so it can never alias the agent row.
const spaceResourcePath = `/api/acl/resources/space/${encodeURIComponent(resourceId)}`;
const spaceResourceKey = `space/${resourceId}`;
const resourceKeys = [resourceId, otherResourceId, spaceResourceKey].sort();
const clientId = "permissions-authority-proof-client";
type Owner = "a" | "b" | "foreign";
interface Overwrite {
	allow: string[];
	deny: string[];
	target_id: string;
	target_type: "role" | "team" | "member" | "org";
}
type Records = Record<Owner, Record<string, Overwrite[]>>;
interface Call {
	bearer: string | null;
	body: unknown;
	delegation: string | null;
	handlerTerminal: boolean;
	id: number;
	method: string;
	owner: Owner | null;
	rawBody: string;
	reply: string | null;
	status: number;
	url: string;
}
interface BodyRead {
	id: number;
	status: number;
	text: string;
}
interface HeldBody {
	cancelled: string | null;
	id: number;
	release: () => void;
	released: boolean;
}
interface HoldPlan {
	bearer: string;
	delegation: string;
	method: "GET" | "PUT";
	owner: Owner;
	path?: string;
	status: 200 | 503;
}
const directory = await mkdtemp(
	join(tmpdir(), "ryu-resource-permissions-authority-")
);
const stateFile = join(directory, "resource-acl-receipt.json");
const calls: Call[] = [];
const bodyStarts: number[] = [];
const bodyReads: BodyRead[] = [];
const heldBodies: HeldBody[] = [];
const unexpected: string[] = [];
const transportErrors: string[] = [];
const runtimeErrors: string[] = [];
const exchanges = new Set<Promise<Response>>();
const observations = new Set<Promise<string>>();
const unreadIds = new Set<number>();
const waiters = new Set<() => void>();
let activeHandlers = 0;
let nextId = 0;
let publicationId = 0;
let persistence = Promise.resolve();
let holdPlan: HoldPlan | null = null;
let caseNumber = 0;
const artifacts = process.env.RYU_RESOURCE_PERMISSIONS_PROOF_ARTIFACTS;

function originalRows(): Overwrite[] {
	return [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.edit"],
			deny: ["space.view"],
		},
	];
}
function currentRows(): Overwrite[] {
	return [
		{
			target_type: "role",
			target_id: "role-current",
			allow: ["space.view"],
			deny: ["space.edit"],
		},
		{
			target_type: "team",
			target_id: "team-retained",
			allow: ["space.view"],
			deny: [],
		},
	];
}
function editedRows(): Overwrite[] {
	return [
		{
			target_type: "role",
			target_id: "role-current",
			allow: ["space.view", "space.edit"],
			deny: [],
		},
		{
			target_type: "team",
			target_id: "team-retained",
			allow: ["space.view"],
			deny: [],
		},
	];
}
function spaceRows(): Overwrite[] {
	return [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.view"],
			deny: [],
		},
	];
}
function seed(): Records {
	return {
		a: {
			[resourceId]: originalRows(),
			[otherResourceId]: [
				{
					target_type: "member",
					target_id: "member-a-retained",
					allow: ["space.view"],
					deny: [],
				},
			],
			[spaceResourceKey]: [
				{
					target_type: "team",
					target_id: "team-retained",
					allow: [],
					deny: ["space.view"],
				},
			],
		},
		b: {
			[resourceId]: currentRows(),
			[otherResourceId]: [
				{
					target_type: "member",
					target_id: "member-b-retained",
					allow: [],
					deny: ["space.edit"],
				},
			],
			[spaceResourceKey]: spaceRows(),
		},
		foreign: {
			[resourceId]: [
				{
					target_type: "role",
					target_id: "role-foreign",
					allow: [],
					deny: ["space.view"],
				},
			],
			[otherResourceId]: [
				{
					target_type: "team",
					target_id: "team-foreign",
					allow: ["space.edit"],
					deny: [],
				},
			],
			[spaceResourceKey]: [
				{
					target_type: "role",
					target_id: "role-foreign",
					allow: ["space.edit"],
					deny: [],
				},
			],
		},
	};
}
function validRows(value: unknown): value is Overwrite[] {
	return (
		Array.isArray(value) &&
		value.every((row: unknown) => {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				return false;
			}
			if (
				Object.keys(row).sort().join("|") !== "allow|deny|target_id|target_type"
			) {
				return false;
			}
			const type: unknown = Reflect.get(row, "target_type");
			const id: unknown = Reflect.get(row, "target_id");
			const allow: unknown = Reflect.get(row, "allow");
			const deny: unknown = Reflect.get(row, "deny");
			return (
				typeof type === "string" &&
				["role", "team", "member", "org"].includes(type) &&
				typeof id === "string" &&
				id.length > 0 &&
				id.length <= 300 &&
				Array.isArray(allow) &&
				Array.isArray(deny) &&
				allow.length <= 100 &&
				deny.length <= 100 &&
				[...allow, ...deny].every(
					(permission: unknown) =>
						permission === "space.view" || permission === "space.edit"
				)
			);
		})
	);
}
async function readPhysical(): Promise<Records> {
	const parsed: unknown = JSON.parse(await readFile(stateFile, "utf8"));
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		Object.keys(parsed).sort().join("|") !== "a|b|foreign"
	) {
		throw new Error("Invalid physical ACL receipt");
	}
	for (const owner of ["a", "b", "foreign"] as const) {
		const resources: unknown = Reflect.get(parsed, owner);
		if (
			!resources ||
			typeof resources !== "object" ||
			Array.isArray(resources) ||
			Object.keys(resources).sort().join("|") !== resourceKeys.join("|") ||
			!Object.values(resources).every(validRows)
		) {
			throw new Error(`Invalid physical ACL namespace ${owner}`);
		}
	}
	return parsed as Records;
}
async function publish(transform: (previous: Records | null) => Records) {
	const temporary = join(directory, `resource-acl-${++publicationId}.tmp`);
	const operation = persistence.then(async () => {
		let previous: Records | null;
		try {
			previous = await readPhysical();
		} catch (error) {
			if (
				!(error instanceof Error) ||
				Reflect.get(error, "code") !== "ENOENT"
			) {
				throw error;
			}
			previous = null;
		}
		const value = transform(previous);
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(value));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, stateFile);
			const parent = await open(directory, "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} finally {
			await rm(temporary, { force: true });
		}
	});
	// Each caller retains its actual publication failure. Only the queue tail
	// recovers so a later explicit write may retry without truncating a live GET.
	persistence = operation.catch(() => undefined);
	await operation;
}
function notify() {
	for (const wake of [...waiters]) {
		wake();
	}
}
function changed() {
	return new Promise<void>((resolve, reject) => {
		const timer = nativeSetTimeout(() => {
			waiters.delete(wake);
			reject(
				new Error(
					"Native permission response did not finish its genuine decoder"
				)
			);
		}, 4000);
		const wake = () => {
			nativeClearTimeout(timer);
			waiters.delete(wake);
			resolve();
		};
		waiters.add(wake);
	});
}
async function drain() {
	while (
		exchanges.size ||
		observations.size ||
		unreadIds.size ||
		activeHandlers
	) {
		const pending = [...exchanges, ...observations];
		if (pending.length) {
			await Promise.allSettled(pending);
		} else {
			await changed();
		}
	}
	await persistence;
}
function heldSnapshot() {
	return heldBodies.map(({ id, released, cancelled }) => ({
		id,
		released,
		cancelled,
	}));
}
function releaseAll() {
	for (const held of heldBodies) {
		held.release();
	}
}

function credentials(owner: Owner, variant: "a" | "bearer" | "jwt" = "a") {
	return {
		token:
			variant === "bearer"
				? `permissions-${owner}-bearer-b`
				: `permissions-${owner}-bearer-a`,
		userJwt:
			variant === "jwt"
				? `permissions-${owner}-jwt-b`
				: `permissions-${owner}-jwt-a`,
	};
}
function admittedCredentials(
	owner: Owner,
	bearer: string | null,
	delegation: string | null
) {
	const variants =
		owner === "a" ? (["a", "bearer", "jwt"] as const) : (["a"] as const);
	return variants.some((variant) => {
		const credential = credentials(owner, variant);
		return (
			bearer === `Bearer ${credential.token}` &&
			delegation === credential.userJwt
		);
	});
}
function vocabulary() {
	return {
		collisions: [],
		kernel: ["space.view", "space.edit"],
		declared: [
			{
				id: "space.view",
				label: "View items",
				description: "View this resource.",
				implies: [],
				plugin_id: "",
			},
			{
				id: "space.edit",
				label: "Edit items",
				description: "Edit this resource.",
				implies: ["space.view"],
				plugin_id: "",
			},
		],
	};
}
function principals(owner: Owner) {
	return {
		kinds: ["agent"],
		org_id: `org-${owner}`,
		members: [],
		roles: [
			{ id: "role-source", label: "Source role" },
			{ id: "role-current", label: "Current role" },
			{ id: "role-foreign", label: "Foreign role" },
		],
		teams: [{ id: "team-retained", name: "Retained team" }],
	};
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		activeHandlers += 1;
		const url = new URL(request.url);
		const prefix = url.pathname.split("/")[1];
		const owner: Owner | null =
			prefix === "a" || prefix === "b" || prefix === "foreign" ? prefix : null;
		const call: Call = {
			id: ++nextId,
			owner,
			method: request.method,
			url: request.url,
			bearer: request.headers.get("authorization"),
			delegation: request.headers.get("x-ryu-user-jwt"),
			rawBody: "",
			body: null,
			status: 0,
			reply: null,
			handlerTerminal: false,
		};
		calls.push(call);
		const reply = (body: unknown, status = 200, hold = false): Response => {
			const text = JSON.stringify(body);
			call.status = status;
			call.reply = text;
			const headers = {
				"content-type": "application/json",
				"x-permissions-proof-call": String(call.id),
			};
			if (!hold) {
				return new NativeResponse(text, { status, headers });
			}
			const bytes = new NativeTextEncoder().encode(text);
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			const held: HeldBody = {
				id: call.id,
				released: false,
				cancelled: null,
				release() {
					if (held.released || held.cancelled !== null) {
						return;
					}
					if (!controller) {
						throw new Error("Missing native held-body controller");
					}
					controller.enqueue(bytes.subarray(1));
					controller.close();
					held.released = true;
					notify();
				},
			};
			const stream = new NativeReadableStream<Uint8Array>({
				start(next) {
					controller = next;
					next.enqueue(bytes.subarray(0, 1));
				},
				cancel(reason: unknown) {
					held.cancelled = String(reason);
					transportErrors.push(
						`Native held body ${call.id} cancelled: ${String(reason)}`
					);
					notify();
				},
			});
			heldBodies.push(held);
			return new NativeResponse(stream, { status, headers });
		};
		const refuse = (reason: string, status = 400) => {
			unexpected.push(`${call.id} ${request.method} ${request.url}: ${reason}`);
			return reply({ error: reason }, status);
		};
		try {
			const raw = await request.text();
			call.rawBody = raw;
			if (raw !== "") {
				try {
					call.body = JSON.parse(raw);
				} catch {
					return refuse("Malformed permission JSON");
				}
			}
			if (
				!owner ||
				url.origin !== server.url.origin ||
				url.search !== "" ||
				url.hash !== ""
			) {
				return refuse("Unowned authority or query");
			}
			const identityNames = [...request.headers.keys()]
				.filter((name) => name.startsWith("x-ryu-"))
				.sort();
			if (
				request.headers.get("content-type") !== "application/json" ||
				request.headers.get("origin") !== null ||
				identityNames.join("|") !==
					"x-ryu-client-id|x-ryu-client-label|x-ryu-surface|x-ryu-user-jwt" ||
				request.headers.get("x-ryu-client-id") !== clientId ||
				request.headers.get("x-ryu-client-label") !== "Desktop" ||
				request.headers.get("x-ryu-surface") !== "desktop"
			) {
				return refuse("Unexpected permission identity headers");
			}
			if (!admittedCredentials(owner, call.bearer, call.delegation)) {
				return refuse("Wrong node credential tuple", 401);
			}
			const path = url.pathname.slice(`/${owner}`.length);
			if (request.method === "GET" && raw !== "") {
				return refuse("Read body is not empty");
			}
			if (path === "/api/acl/vocabulary" && request.method === "GET") {
				return reply(vocabulary());
			}
			if (path === "/api/acl/principals" && request.method === "GET") {
				return reply(principals(owner));
			}
			if (
				path !== resourcePath &&
				path !== otherResourcePath &&
				path !== spaceResourcePath
			) {
				return refuse("Undeclared ACL route", 404);
			}
			const id =
				path === resourcePath
					? resourceId
					: path === otherResourcePath
						? otherResourceId
						: spaceResourceKey;
			const kind = path === spaceResourcePath ? "space" : "agent";
			if (request.method !== "GET" && request.method !== "PUT") {
				return refuse("Undeclared ACL method", 405);
			}
			if (
				request.method === "PUT" &&
				((path !== resourcePath && path !== spaceResourcePath) ||
					!call.body ||
					typeof call.body !== "object" ||
					Array.isArray(call.body) ||
					Object.keys(call.body).join("|") !== "overwrites" ||
					!validRows(Reflect.get(call.body, "overwrites")))
			) {
				return refuse("Unexpected whole-set ACL write");
			}
			const plan = holdPlan;
			const held = Boolean(
				plan &&
					path === (plan.path ?? resourcePath) &&
					plan.owner === owner &&
					plan.method === request.method &&
					`Bearer ${plan.bearer}` === call.bearer &&
					plan.delegation === call.delegation
			);
			if (held) {
				holdPlan = null;
			}
			if (held && plan?.status === 503) {
				return reply({ error: "Owned ACL peer unavailable" }, 503, true);
			}
			if (request.method === "PUT") {
				const body = call.body as { overwrites: Overwrite[] };
				await publish((previous) => {
					if (!previous) {
						throw new Error("Missing initialized ACL receipt");
					}
					return {
						...previous,
						[owner]: {
							...previous[owner],
							[id]: structuredClone(body.overwrites),
						},
					};
				});
				return reply({ ok: true }, 200, held);
			}
			// Every GET independently opens the committed file, including fresh
			// renderer reads. Same-node credentials never own separate ACL records.
			const physical = await readPhysical();
			return reply(
				{
					kind,
					id: kind === "space" ? resourceId : id,
					overwrites: physical[owner][id],
				},
				200,
				held
			);
		} catch (error) {
			transportErrors.push(`Native handler ${call.id}: ${String(error)}`);
			return reply(
				{ error: "Owned ACL fixture publication/read failure" },
				500
			);
		} finally {
			call.handlerTerminal = true;
			activeHandlers -= 1;
			notify();
		}
	},
});

// Passive observation delegates the actual Bun body decoder. The response's
// declared physical ID joins bytes/status consumed by the genuine SDK.
NativeResponse.prototype.text = function (this: Response) {
	const raw = this.headers.get("x-permissions-proof-call");
	const id = raw === null ? null : Number(raw);
	if (id !== null) {
		bodyStarts.push(id);
	}
	const observation = (async () => {
		const text = await nativeResponseText.call(this);
		if (id !== null) {
			bodyReads.push({ id, status: this.status, text });
		}
		return text;
	})();
	observations.add(observation);
	const complete = () => {
		observations.delete(observation);
		if (id !== null) {
			unreadIds.delete(id);
		}
		notify();
	};
	void observation.then(complete, (error: unknown) => {
		transportErrors.push(`Native decoder ${id}: ${String(error)}`);
		complete();
	});
	return observation;
};
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== server.url.origin) {
			unexpected.push(`Unowned fetch ${request.method} ${request.url}`);
			throw new Error("Refused unowned permission destination");
		}
		const exchange = nativeFetch(request);
		exchanges.add(exchange);
		try {
			const response = await exchange;
			const id = response.headers.get("x-permissions-proof-call");
			if (id === null) {
				throw new Error("Native peer returned no physical response identity");
			}
			unreadIds.add(Number(id));
			return response;
		} catch (error) {
			transportErrors.push(
				`Native exchange ${request.method} ${request.url}: ${String(error)}`
			);
			throw error;
		} finally {
			exchanges.delete(exchange);
			notify();
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			if (new URL(String(args[0])).origin !== server.url.origin) {
				unexpected.push(`Unowned preconnect ${String(args[0])}`);
				throw new Error("Refused unowned permission preconnect");
			}
			return nativeFetch.preconnect(...args);
		},
	}
);
const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { request } = await import("@/src/lib/api/client.ts");
const { gatewayJsonValueSchema } = await import(
	"@/src/lib/api/gateway-json-contracts.ts"
);
const { BACKEND_URL, TOKEN_KEY, vaultHydrated } = await import(
	"@/lib/auth-client.ts"
);
const { ResourcePermissions } = await import("./ResourcePermissions.tsx");
await vaultHydrated;
const previousNodes = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

function node(owner: Owner, variant: "a" | "bearer" | "jwt" = "a"): Node {
	return {
		name: `permissions-${owner}`,
		url: `${server.url.origin}/${owner}`,
		...credentials(owner, variant),
	};
}
function target(
	owner: Owner,
	variant: "a" | "bearer" | "jwt" = "a"
): ApiTarget {
	const current = node(owner, variant);
	return { url: current.url, token: current.token, userJwt: current.userJwt };
}
async function selectNode(current: Node) {
	await act(async () =>
		useNodeStore.setState({
			nodes: [current],
			localNodes: [current],
			cloudNodes: [],
			defaultNode: current.name,
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		})
	);
}
interface EditedResource {
	id: string;
	kind: "agent" | "space";
}
// The mounted host owns which resource the real editor receives, exactly as a
// settings page switching between agents or spaces passes new props.
let selectResource: ((next: EditedResource) => void) | null = null;
function Surface() {
	const [draft, setDraft] = useState("Unsent permissions draft");
	const [resource, setResource] = useState<EditedResource>({
		kind: "agent",
		id: resourceId,
	});
	useEffect(() => {
		selectResource = setResource;
		return () => {
			selectResource = null;
		};
	}, []);
	return (
		<>
			<input
				aria-label="Unsent permissions draft"
				onChange={(event) => setDraft(event.target.value)}
				value={draft}
			/>
			<div data-permissions-editor="">
				<ResourcePermissions
					resourceId={resource.id}
					resourceKind={resource.kind}
					resourceName="Authority receipt"
				/>
			</div>
			<Toaster theme="light" />
		</>
	);
}
function tree() {
	return (
		<I18nProvider>
			<Surface />
		</I18nProvider>
	);
}
async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
function editor() {
	const current = container?.querySelector<HTMLElement>(
		"[data-permissions-editor]"
	);
	if (!current) {
		throw new Error("Missing real permission editor");
	}
	return current;
}
function button(name: string, within: ParentNode = editor()) {
	const current = [
		...within.querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === name);
	if (!current) {
		throw new Error(`Missing real permission action ${name}`);
	}
	return current;
}
function draftInput() {
	const current = container?.querySelector<HTMLInputElement>(
		'[aria-label="Unsent permissions draft"]'
	);
	if (!current) {
		throw new Error("Missing retained draft consumer");
	}
	return current;
}
function permissionElement(index: number, name: "View items" | "Edit items") {
	const card = editor().querySelectorAll("li")[index];
	if (!card) {
		throw new Error(`Missing actual overwrite card ${index}`);
	}
	const label = [...card.querySelectorAll("p")].find(
		(item) => item.textContent?.trim() === name
	);
	const row = label?.parentElement?.parentElement;
	if (!row) {
		throw new Error(`Missing actual permission row ${name}`);
	}
	return row;
}
function editPermission(
	name: "View items" | "Edit items",
	setting: "Allow" | "Deny" | "Inherit"
) {
	return act(async () => button(setting, permissionElement(0, name)).click());
}
function assertRenderedRows(rows: Overwrite[]) {
	const cards = [...editor().querySelectorAll("li")];
	expect(cards).toHaveLength(rows.length);
	for (const [index, row] of rows.entries()) {
		const expectedLabel =
			row.target_id === "role-current"
				? "Current role"
				: row.target_id === "team-retained"
					? "Retained team"
					: "Source role";
		expect(cards[index]?.textContent).toContain(expectedLabel);
		for (const [permission, label] of [
			["space.view", "View items"],
			["space.edit", "Edit items"],
		] as const) {
			const expected = row.deny.includes(permission)
				? "Deny"
				: row.allow.includes(permission)
					? "Allow"
					: "Inherit";
			// The shipping tri-state control exposes selection through its real
			// default Button appearance. No fixture-created selection attribute.
			const actual = permissionElement(index, label);
			for (const setting of ["Deny", "Inherit", "Allow"] as const) {
				expect(button(setting, actual).classList.contains("bg-primary")).toBe(
					setting === expected
				);
			}
		}
	}
}
function acknowledged(call: Call) {
	return bodyReads.find((read) => read.id === call.id);
}
function publishedReply(call: Call): string {
	if (typeof call.reply !== "string") {
		throw new Error(
			`Actual native request ${call.id} has no published response bytes`
		);
	}
	return call.reply;
}
async function mount() {
	expect(BACKEND_URL).toBe(server.url.origin);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () => root!.render(tree()));
}
async function completeRead(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	after: number,
	label: string
) {
	const credential = credentials(owner, variant);
	await until(
		() =>
			["/api/acl/vocabulary", "/api/acl/principals", resourcePath].every(
				(path) =>
					calls.some(
						(call) =>
							call.id > after &&
							call.owner === owner &&
							call.method === "GET" &&
							call.url === `${node(owner).url}${path}` &&
							call.bearer === `Bearer ${credential.token}` &&
							call.delegation === credential.userJwt &&
							acknowledged(call)?.status === 200
					)
			),
		"Actual editor did not consume all three captured-authority read bodies"
	);
	await until(
		() =>
			editor().textContent?.includes(label) === true &&
			!editor().textContent?.includes("Loading permissions"),
		"Actual editor did not render its acknowledged target rows"
	);
}
async function releaseAndConsume(held: HeldBody) {
	await act(async () => {
		held.release();
		await drain();
	});
	expect(held.released).toBe(true);
	expect(held.cancelled).toBeNull();
	const call = calls.find((item) => item.id === held.id)!;
	expect(acknowledged(call)).toEqual({
		id: call.id,
		status: call.status,
		text: publishedReply(call),
	});
	await act(async () => {
		await drain();
	});
}
async function externalWrite(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	rows: Overwrite[]
) {
	const start = nextId;
	await act(async () => {
		expect(
			await request(
				target(owner, variant),
				resourcePath,
				{
					method: "PUT",
					body: { overwrites: rows },
				},
				gatewayJsonValueSchema
			)
		).toEqual({ ok: true });
	});
	const write = calls.find(
		(call) => call.id > start && call.owner === owner && call.method === "PUT"
	)!;
	const credential = credentials(owner, variant);
	expect(write).toMatchObject({
		owner,
		method: "PUT",
		url: `${node(owner).url}${resourcePath}`,
		bearer: `Bearer ${credential.token}`,
		delegation: credential.userJwt,
		body: { overwrites: rows },
		status: 200,
	});
	expect(acknowledged(write)).toEqual({
		id: write.id,
		status: 200,
		text: JSON.stringify({ ok: true }),
	});
	return write;
}
async function saveCurrent(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	rows: Overwrite[]
) {
	const start = nextId;
	expect(button("Save").disabled).toBe(false);
	await act(async () => button("Save").click());
	await until(
		() =>
			calls.some(
				(call) =>
					call.id > start &&
					call.owner === owner &&
					call.method === "PUT" &&
					acknowledged(call)?.status === 200
			),
		"Actual current Save did not consume its native acknowledgment"
	);
	const write = calls.find(
		(call) => call.id > start && call.owner === owner && call.method === "PUT"
	)!;
	const credential = credentials(owner, variant);
	expect(write).toMatchObject({
		body: { overwrites: rows },
		bearer: `Bearer ${credential.token}`,
		delegation: credential.userJwt,
		status: 200,
	});
	expect(acknowledged(write)?.text).toBe(JSON.stringify({ ok: true }));
	await completeRead(owner, variant, write.id, "Current role");
	await until(
		() =>
			document.body.textContent?.includes("Permissions saved") === true &&
			button("Save").disabled,
		"Real Save consumer did not acknowledge persisted clean state and success Toaster"
	);
	await act(async () => {
		await drain();
	});
	assertRenderedRows(rows);
}
async function assertForeignRead(expected: Records) {
	const start = nextId;
	expect(
		await request(
			target("foreign"),
			resourcePath,
			undefined,
			// Strict, so a read carrying anything beyond the ACL document fails.
			z
				.object({
					id: z.string(),
					kind: z.string(),
					overwrites: z.array(z.unknown()),
				})
				.strict()
		)
	).toEqual({
		kind: "agent",
		id: resourceId,
		overwrites: expected.foreign[resourceId],
	});
	const read = calls.find((call) => call.id > start)!;
	expect(read).toMatchObject({
		owner: "foreign",
		method: "GET",
		body: null,
		bearer: "Bearer permissions-foreign-bearer-a",
		delegation: "permissions-foreign-jwt-a",
		status: 200,
	});
	expect(acknowledged(read)?.text).toBe(
		JSON.stringify({
			kind: "agent",
			id: resourceId,
			overwrites: expected.foreign[resourceId],
		})
	);
	expect(await readPhysical()).toEqual(expected);
}
async function assertFreshRenderer(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	expected: Records
) {
	await unmount();
	const start = nextId;
	await selectNode(node(owner, variant));
	await mount();
	await completeRead(owner, variant, start, "Current role");
	expect(editor().querySelectorAll("li")).toHaveLength(2);
	expect(editor().textContent).toContain("Retained team");
	expect(button("Save").disabled).toBe(true);
	assertRenderedRows(expected[owner][resourceId]!);
	expect(await readPhysical()).toEqual(expected);
	await assertForeignRead(expected);
}
async function assertRetiredConsumer(expected: Records) {
	await unmount();
	const start = nextId;
	await selectNode(node("b"));
	await act(async () => {
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "ryu_node_tab_override_enabled",
				newValue: "false",
			})
		);
		// A genuine independently awaited request supplies an HTTP/decoder
		// boundary after the real store/storage events. No guessed quiet delay.
		await assertForeignRead(expected);
		await drain();
	});
	const later = calls.filter((call) => call.id > start);
	expect(later).toHaveLength(1);
	expect(later[0]).toMatchObject({
		owner: "foreign",
		method: "GET",
		url: `${node("foreign").url}${resourcePath}`,
	});
	expect(runtimeErrors).toEqual([]);
}
function assertRetainedDraft(draft: HTMLInputElement) {
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Unsent permissions draft");
	expect(document.activeElement).toBe(draft);
	expect(localStorage.getItem("permissions-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
}
async function unmount() {
	// Always release genuine held responses BEFORE awaiting old SDK work. A
	// primary assertion failure must retain its real late receipt, not deadlock
	// teardown or manufacture cancellation/consumption.
	const errors: unknown[] = [];
	try {
		await act(async () => {
			releaseAll();
			await drain();
		});
	} catch (error) {
		errors.push(error);
	}
	try {
		await act(async () => {
			root?.unmount();
			await drain();
		});
	} catch (error) {
		errors.push(error);
	}
	root = null;
	container?.remove();
	container = null;
	if (errors.length) {
		throw new AggregateError(
			errors,
			"Real permission renderer teardown failed"
		);
	}
}
function assertClosure() {
	expect(activeHandlers).toBe(0);
	expect(server.pendingRequests).toBe(0);
	expect(exchanges.size).toBe(0);
	expect(observations.size).toBe(0);
	expect([...unreadIds]).toEqual([]);
	expect(unexpected).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expect(transportErrors).toEqual([]);
	expect(
		heldBodies.every((held) => held.released && held.cancelled === null)
	).toBe(true);
	expect(calls.every((call) => call.handlerTerminal && call.status !== 0)).toBe(
		true
	);
	expect(bodyReads.map((body) => body.id).sort((a, b) => a - b)).toEqual(
		calls.map((call) => call.id).sort((a, b) => a - b)
	);
	for (const call of calls) {
		expect(acknowledged(call)).toEqual({
			id: call.id,
			status: call.status,
			text: publishedReply(call),
		});
	}
}
function diagnostic() {
	return {
		calls,
		bodyStarts,
		bodyReads,
		heldBodies: heldSnapshot(),
		activeHandlers,
		pendingRequests: server.pendingRequests,
		exchanges: exchanges.size,
		bodyObservations: observations.size,
		unreadIds: [...unreadIds],
		unexpected,
		transportErrors,
		runtimeErrors,
	};
}
beforeEach(async () => {
	await unmount();
	await act(async () => sileo.clear());
	localStorage.clear();
	localStorage.setItem("ryu_client_id", clientId);
	localStorage.setItem("permissions-unrelated", "preserved");
	localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
	await publish(() => seed());
	calls.length = 0;
	bodyReads.length = 0;
	bodyStarts.length = 0;
	heldBodies.length = 0;
	unexpected.length = 0;
	transportErrors.length = 0;
	runtimeErrors.length = 0;
	holdPlan = null;
	await selectNode(node("a"));
});
afterEach(async () => {
	const errors: unknown[] = [];
	try {
		await unmount();
		assertClosure();
	} catch (error) {
		errors.push(error);
	} finally {
		if (artifacts) {
			try {
				await mkdir(artifacts, { recursive: true });
				await writeFile(
					join(artifacts, `case-${++caseNumber}.json`),
					JSON.stringify(
						{
							...diagnostic(),
							cleanupErrors: errors.map(String),
							physical: await readPhysical(),
						},
						null,
						2
					)
				);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	if (errors.length) {
		throw new AggregateError(errors, "Real permission per-case closure failed");
	}
});
afterAll(async () => {
	const errors: unknown[] = [];
	let serverStopAcknowledged = false;
	try {
		await unmount();
		await act(async () => sileo.clear());
	} catch (error) {
		errors.push(error);
	}
	try {
		await server.stop(true);
		serverStopAcknowledged = true;
	} catch (error) {
		errors.push(error);
	}
	try {
		await Promise.allSettled([...exchanges, ...observations]);
		await persistence;
		assertClosure();
		expect(serverStopAcknowledged).toBe(true);
	} catch (error) {
		errors.push(error);
	}
	try {
		if (artifacts) {
			await mkdir(artifacts, { recursive: true });
			await writeFile(
				join(artifacts, "closure.json"),
				JSON.stringify(
					{
						...diagnostic(),
						serverStopAcknowledged,
						closureErrors: errors.map(String),
					},
					null,
					2
				)
			);
		}
	} catch (error) {
		errors.push(error);
	}
	try {
		await rm(directory, { recursive: true });
	} catch (error) {
		errors.push(error);
	}
	try {
		useNodeStore.setState(previousNodes);
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onRejection);
		NativeResponse.prototype.text = nativeResponseText;
		globalThis.fetch = nativeFetch;
		if (previousBackend === undefined) {
			delete process.env.VITE_APP_BACKEND_URL;
		} else {
			process.env.VITE_APP_BACKEND_URL = previousBackend;
		}
		if (previousActFlag) {
			Object.defineProperty(
				globalThis,
				"IS_REACT_ACT_ENVIRONMENT",
				previousActFlag
			);
		} else {
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		}
		if (domAbortController) {
			Object.defineProperty(globalThis, "AbortController", domAbortController);
		} else {
			Reflect.deleteProperty(globalThis, "AbortController");
		}
		if (domAbortSignal) {
			Object.defineProperty(globalThis, "AbortSignal", domAbortSignal);
		} else {
			Reflect.deleteProperty(globalThis, "AbortSignal");
		}
		if (ownsDom) {
			await GlobalRegistrator.unregister();
		}
	} catch (error) {
		errors.push(error);
	}
	if (errors.length) {
		throw new AggregateError(errors, "Real permission final closure failed");
	}
});

test("a late prior-node ACL read cannot replace current targets or poison the next acknowledged whole-set save", async () => {
	const original = await readPhysical();
	holdPlan = {
		owner: "a",
		method: "GET",
		bearer: credentials("a").token,
		delegation: credentials("a").userJwt,
		status: 200,
	};
	await mount();
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real A resource decoder did not await its held body"
	);
	const held = heldBodies[0]!;
	const start = nextId;
	await selectNode(node("b"));
	await completeRead("b", "a", start, "Current role");
	const draft = draftInput();
	draft.focus();
	await releaseAndConsume(held);
	expect(calls.find((call) => call.id === held.id)).toMatchObject({
		owner: "a",
		method: "GET",
		url: `${node("a").url}${resourcePath}`,
		bearer: "Bearer permissions-a-bearer-a",
		delegation: "permissions-a-jwt-a",
		rawBody: "",
		status: 200,
	});
	expect(acknowledged(calls.find((call) => call.id === held.id)!)?.text).toBe(
		JSON.stringify({
			kind: "agent",
			id: resourceId,
			overwrites: original.a[resourceId],
		})
	);
	expect(editor().textContent).toContain("Current role");
	expect(editor().textContent).toContain("Retained team");
	expect(editor().textContent).not.toContain("Source role");
	expect(editor().querySelectorAll("li")).toHaveLength(2);
	assertRenderedRows(currentRows());
	expect(await readPhysical()).toEqual(original);
	assertRetainedDraft(draft);
	await editPermission("Edit items", "Allow");
	draft.focus();
	await saveCurrent("b", "a", editedRows());
	const expected: Records = {
		...original,
		b: { ...original.b, [resourceId]: editedRows() },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("b", "a", expected);
	await assertRetiredConsumer(expected);
});

test("a retired Bearer-scope ACL save refusal cannot publish a current error or discard the next retry draft", async () => {
	const start = nextId;
	await mount();
	await completeRead("a", "a", start, "Source role");
	const original = await readPhysical();
	await editPermission("View items", "Allow");
	holdPlan = {
		owner: "a",
		method: "PUT",
		bearer: credentials("a").token,
		delegation: credentials("a").userJwt,
		status: 503,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real old Save refusal decoder did not await its body"
	);
	const held = heldBodies[0]!;
	expect(await readPhysical()).toEqual(original);
	await externalWrite("a", "bearer", currentRows());
	const expectedBeforeRetry: Records = {
		...original,
		a: { ...original.a, [resourceId]: currentRows() },
	};
	expect(await readPhysical()).toEqual(expectedBeforeRetry);
	const rotatedStart = nextId;
	await selectNode(node("a", "bearer"));
	await completeRead("a", "bearer", rotatedStart, "Current role");
	await editPermission("Edit items", "Allow");
	const draft = draftInput();
	draft.focus();
	await releaseAndConsume(held);
	const refusal = calls.find((call) => call.id === held.id)!;
	expect(refusal).toMatchObject({
		owner: "a",
		method: "PUT",
		status: 503,
		bearer: "Bearer permissions-a-bearer-a",
		delegation: "permissions-a-jwt-a",
		body: {
			overwrites: [
				{
					target_type: "role",
					target_id: "role-source",
					allow: ["space.edit", "space.view"],
					deny: [],
				},
			],
		},
	});
	expect(acknowledged(refusal)?.text).toBe(
		JSON.stringify({ error: "Owned ACL peer unavailable" })
	);
	expect(editor().textContent).toContain("Current role");
	expect(button("Save").disabled).toBe(false);
	assertRenderedRows(editedRows());
	expect(document.body.textContent).not.toContain("Could not save permissions");
	expect(await readPhysical()).toEqual(expectedBeforeRetry);
	assertRetainedDraft(draft);
	await saveCurrent("a", "bearer", editedRows());
	const expected: Records = {
		...original,
		a: { ...original.a, [resourceId]: editedRows() },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("a", "bearer", expected);
	await assertRetiredConsumer(expected);
});

test("a held successful ACL save stays retired after JWT A-B-A and cannot refresh away a newer unsaved whole-set edit", async () => {
	const start = nextId;
	await mount();
	await completeRead("a", "a", start, "Source role");
	const original = await readPhysical();
	await editPermission("View items", "Allow");
	holdPlan = {
		owner: "a",
		method: "PUT",
		bearer: credentials("a").token,
		delegation: credentials("a").userJwt,
		status: 200,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real successful old Save did not wait for acknowledgment bytes"
	);
	const held = heldBodies[0]!;
	const savedOriginalRows: Overwrite[] = [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.edit", "space.view"],
			deny: [],
		},
	];
	expect(calls.find((call) => call.id === held.id)).toMatchObject({
		owner: "a",
		method: "PUT",
		bearer: "Bearer permissions-a-bearer-a",
		delegation: "permissions-a-jwt-a",
		body: { overwrites: savedOriginalRows },
		status: 200,
	});
	expect(await readPhysical()).toEqual({
		...original,
		a: { ...original.a, [resourceId]: savedOriginalRows },
	});
	await externalWrite("a", "jwt", currentRows());
	const expectedBeforeRetry: Records = {
		...original,
		a: { ...original.a, [resourceId]: currentRows() },
	};
	let rotatedStart = nextId;
	await selectNode(node("a", "jwt"));
	await completeRead("a", "jwt", rotatedStart, "Current role");
	rotatedStart = nextId;
	await selectNode(node("a"));
	await completeRead("a", "a", rotatedStart, "Current role");
	await editPermission("Edit items", "Allow");
	const draft = draftInput();
	draft.focus();
	const beforeReceipt = calls.map((call) => call.id);
	await releaseAndConsume(held);
	expect(acknowledged(calls.find((call) => call.id === held.id)!)).toEqual({
		id: held.id,
		status: 200,
		text: JSON.stringify({ ok: true }),
	});
	expect(editor().textContent).toContain("Current role");
	expect(editor().textContent).toContain("Retained team");
	expect(button("Save").disabled).toBe(false);
	assertRenderedRows(editedRows());
	expect(document.body.textContent).not.toContain("Permissions saved");
	expect(calls.map((call) => call.id)).toEqual(beforeReceipt);
	expect(await readPhysical()).toEqual(expectedBeforeRetry);
	assertRetainedDraft(draft);
	await saveCurrent("a", "a", editedRows());
	const expected: Records = {
		...original,
		a: { ...original.a, [resourceId]: editedRows() },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("a", "a", expected);
	await assertRetiredConsumer(expected);
});

test("an acknowledged same-authority Save cannot erase a newer pending tri-state draft before its next whole-set save", async () => {
	await selectNode(node("b"));
	const start = nextId;
	await mount();
	await completeRead("b", "a", start, "Current role");
	const original = await readPhysical();
	await editPermission("Edit items", "Allow");
	const savedRows = editedRows();
	assertRenderedRows(savedRows);
	holdPlan = {
		owner: "b",
		method: "PUT",
		bearer: credentials("b").token,
		delegation: credentials("b").userJwt,
		status: 200,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real same-authority Save did not await its held acknowledgment body"
	);
	const held = heldBodies[0]!;
	const write = calls.find((call) => call.id === held.id)!;
	expect(write).toMatchObject({
		owner: "b",
		method: "PUT",
		url: `${node("b").url}${resourcePath}`,
		bearer: "Bearer permissions-b-bearer-a",
		delegation: "permissions-b-jwt-a",
		body: { overwrites: savedRows },
		status: 200,
	});
	expect(acknowledged(write)).toBeUndefined();
	const expectedBeforeNextSave: Records = {
		...original,
		b: { ...original.b, [resourceId]: savedRows },
	};
	// The real peer has already committed the first write, even though its
	// native SDK acknowledgment remains unread. No rollback is invented here.
	expect(await readPhysical()).toEqual(expectedBeforeNextSave);
	expect(button("Saving…").disabled).toBe(true);
	const newerControl = button("Deny", permissionElement(0, "View items"));
	expect(newerControl.disabled).toBe(false);
	await editPermission("View items", "Deny");
	const newerRows: Overwrite[] = [
		{
			target_type: "role",
			target_id: "role-current",
			allow: ["space.edit"],
			deny: ["space.view"],
		},
		{
			target_type: "team",
			target_id: "team-retained",
			allow: ["space.view"],
			deny: [],
		},
	];
	assertRenderedRows(newerRows);
	const draft = draftInput();
	newerControl.focus();
	expect(document.activeElement).toBe(newerControl);
	const beforeReceipt = calls.map((call) => call.id);
	await releaseAndConsume(held);
	expect(acknowledged(write)).toEqual({
		id: held.id,
		status: 200,
		text: JSON.stringify({ ok: true }),
	});
	expect(button("Save").disabled).toBe(false);
	assertRenderedRows(newerRows);
	expect(button("Deny", permissionElement(0, "View items"))).toBe(newerControl);
	expect(document.activeElement).toBe(newerControl);
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Unsent permissions draft");
	expect(localStorage.getItem("permissions-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	expect(calls.map((call) => call.id)).toEqual(beforeReceipt);
	expect(await readPhysical()).toEqual(expectedBeforeNextSave);
	await assertForeignRead(expectedBeforeNextSave);
	await saveCurrent("b", "a", newerRows);
	const expected: Records = {
		...original,
		b: { ...original.b, [resourceId]: newerRows },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("b", "a", expected);
	await assertRetiredConsumer(expected);
});

test("switching the edited resource kind or ID retires its held save refusal and read, and saves only the current resource's draft", async () => {
	await selectNode(node("b"));
	let start = nextId;
	await mount();
	await completeRead("b", "a", start, "Current role");
	const original = await readPhysical();
	const resourceRead = async (path: string, after: number, label: string) => {
		await until(
			() =>
				["/api/acl/vocabulary", "/api/acl/principals", path].every((route) =>
					calls.some(
						(call) =>
							call.id > after &&
							call.owner === "b" &&
							call.method === "GET" &&
							call.url === `${node("b").url}${route}` &&
							call.bearer === "Bearer permissions-b-bearer-a" &&
							call.delegation === "permissions-b-jwt-a" &&
							acknowledged(call)?.status === 200
					)
				),
			`Actual editor did not consume all three reads for ${path}`
		);
		await until(
			() =>
				editor().textContent?.includes(label) === true &&
				!editor().textContent?.includes("Loading permissions"),
			`Actual editor did not render acknowledged rows for ${path}`
		);
	};
	const switchResource = (next: EditedResource) =>
		act(async () => {
			if (!selectResource) {
				throw new Error("Mounted resource host is not registered");
			}
			selectResource(next);
		});
	// 1. An agent draft is refused by the node, but its 503 reply is still held.
	await editPermission("Edit items", "Allow");
	assertRenderedRows(editedRows());
	holdPlan = {
		owner: "b",
		method: "PUT",
		bearer: credentials("b").token,
		delegation: credentials("b").userJwt,
		status: 503,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real agent Save refusal did not await its held body"
	);
	const heldRefusal = heldBodies[0]!;
	expect(calls.find((call) => call.id === heldRefusal.id)).toMatchObject({
		owner: "b",
		method: "PUT",
		url: `${node("b").url}${resourcePath}`,
		bearer: "Bearer permissions-b-bearer-a",
		delegation: "permissions-b-jwt-a",
		body: { overwrites: editedRows() },
		status: 503,
	});
	expect(await readPhysical()).toEqual(original);
	// 2. Same kind, different ID: its actual read is held mid-body.
	holdPlan = {
		owner: "b",
		method: "GET",
		path: otherResourcePath,
		bearer: credentials("b").token,
		delegation: credentials("b").userJwt,
		status: 200,
	};
	await switchResource({ kind: "agent", id: otherResourceId });
	await until(
		() => heldBodies.length === 2 && bodyStarts.includes(heldBodies[1]!.id),
		"Real other-ID read did not await its held body"
	);
	const heldRead = heldBodies[1]!;
	expect(editor().textContent).toContain("Loading permissions");
	expect(calls.find((call) => call.id === heldRead.id)).toMatchObject({
		owner: "b",
		method: "GET",
		url: `${node("b").url}${otherResourcePath}`,
		rawBody: "",
		status: 200,
	});
	// 3. Same ID, different kind: the editor reads and drafts the space record.
	start = nextId;
	await switchResource({ kind: "space", id: resourceId });
	await resourceRead(spaceResourcePath, start, "Source role");
	assertRenderedRows(spaceRows());
	expect(editor().textContent).toContain("Exceptions for this space.");
	expect(button("Save").disabled).toBe(true);
	await editPermission("Edit items", "Deny");
	const spaceDraft: Overwrite[] = [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.view"],
			deny: ["space.edit"],
		},
	];
	assertRenderedRows(spaceDraft);
	const draft = draftInput();
	draft.focus();
	const beforeReceipts = calls.map((call) => call.id);
	// 4. Both retired replies are genuinely decoded after the switch. The
	// refusal is consumed first while the other-ID read is still held, so the
	// shared drain only runs once no held body remains.
	await act(async () => {
		heldRefusal.release();
	});
	await until(
		() =>
			acknowledged(calls.find((call) => call.id === heldRefusal.id)!) !==
			undefined,
		"Retired refusal body was not decoded"
	);
	await releaseAndConsume(heldRead);
	expect(heldRefusal.released).toBe(true);
	expect(heldRefusal.cancelled).toBeNull();
	expect(
		acknowledged(calls.find((call) => call.id === heldRefusal.id)!)?.text
	).toBe(JSON.stringify({ error: "Owned ACL peer unavailable" }));
	expect(
		acknowledged(calls.find((call) => call.id === heldRead.id)!)?.text
	).toBe(
		JSON.stringify({
			kind: "agent",
			id: otherResourceId,
			overwrites: original.b[otherResourceId],
		})
	);
	await act(async () => {
		await assertForeignRead(original);
		await drain();
	});
	expect(
		calls.filter(
			(call) => call.id > beforeReceipts.at(-1)! && call.owner !== "foreign"
		)
	).toEqual([]);
	expect(document.body.textContent).not.toContain("Could not save permissions");
	expect(editor().querySelector('[aria-label="Person identifier"]')).toBeNull();
	expect(editor().textContent).toContain("Exceptions for this space.");
	assertRenderedRows(spaceDraft);
	expect(button("Save").disabled).toBe(false);
	expect(await readPhysical()).toEqual(original);
	assertRetainedDraft(draft);
	// 5. The next Save writes only the current kind/ID with the current draft.
	start = nextId;
	await act(async () => button("Save").click());
	await until(
		() =>
			calls.some(
				(call) =>
					call.id > start &&
					call.method === "PUT" &&
					acknowledged(call)?.status === 200
			),
		"Actual space Save did not consume its native acknowledgment"
	);
	const writes = calls.filter(
		(call) => call.id > start && call.method === "PUT"
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		owner: "b",
		url: `${node("b").url}${spaceResourcePath}`,
		bearer: "Bearer permissions-b-bearer-a",
		delegation: "permissions-b-jwt-a",
		body: { overwrites: spaceDraft },
		status: 200,
	});
	await resourceRead(spaceResourcePath, writes[0]!.id, "Source role");
	await until(
		() =>
			document.body.textContent?.includes("Permissions saved") === true &&
			button("Save").disabled,
		"Real space Save did not acknowledge persisted clean state and success Toaster"
	);
	await act(async () => {
		await drain();
	});
	assertRenderedRows(spaceDraft);
	const expected: Records = {
		...original,
		b: { ...original.b, [spaceResourceKey]: spaceDraft },
	};
	expect(await readPhysical()).toEqual(expected);
	// 6. Returning to the agent ID reads its stored rows; the retired refused
	// draft was never written and is not resurrected.
	start = nextId;
	await switchResource({ kind: "agent", id: resourceId });
	await resourceRead(resourcePath, start, "Current role");
	assertRenderedRows(currentRows());
	expect(button("Save").disabled).toBe(true);
	expect(editor().textContent).toContain("Exceptions for this agent.");
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("b", "a", expected);
	await assertRetiredConsumer(expected);
}, 30_000);
