import { mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

/** Module state other suites' modules write, kept on one shared object. */
export const live = {
	activeHandlers: 0,
	nextId: 0,
	publicationId: 0,
	persistence: Promise.resolve(),
	holdPlan: null as HoldPlan | null,
	caseNumber: 0,
	root: null as Root | null,
	container: null as HTMLDivElement | null,
	selectResource: null as ((next: EditedResource) => void) | null,
};

// Source-only proposal. This mounts the shipping editor, active-node hook,
// identity headers, HTTP decoder, UI primitives and Toaster without replacing
// a business module. The invocation owns only its external native HTTP peer.
// Its atomic physical receipt is not Core's ACL store or authorization engine.
export const nativeFetch = globalThis.fetch;
export const NativeRequest = globalThis.Request;
export const NativeResponse = globalThis.Response;
export const NativeAbortController = globalThis.AbortController;
export const NativeAbortSignal = globalThis.AbortSignal;
export const NativeReadableStream = globalThis.ReadableStream;
export const NativeTextEncoder = globalThis.TextEncoder;
export const nativeResponseText = NativeResponse.prototype.text;
export const nativeSetTimeout = globalThis.setTimeout;
export const nativeClearTimeout = globalThis.clearTimeout;
export const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
export const domAbortController = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortController"
);
export const domAbortSignal = Object.getOwnPropertyDescriptor(
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
export const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

export const resourceId = "agent:permissions Ω";
export const otherResourceId = "agent:untouched";
export const resourcePath = `/api/acl/resources/agent/${encodeURIComponent(resourceId)}`;
export const otherResourcePath = `/api/acl/resources/agent/${encodeURIComponent(otherResourceId)}`;
// The same identifier under a different resource kind is a different ACL
// record. Its physical key keeps the kind so it can never alias the agent row.
export const spaceResourcePath = `/api/acl/resources/space/${encodeURIComponent(resourceId)}`;
export const spaceResourceKey = `space/${resourceId}`;
export const resourceKeys = [
	resourceId,
	otherResourceId,
	spaceResourceKey,
].sort();
export const clientId = "permissions-authority-proof-client";
export type Owner = "a" | "b" | "foreign";
export interface Overwrite {
	allow: string[];
	deny: string[];
	target_id: string;
	target_type: "role" | "team" | "member" | "org";
}
export type Records = Record<Owner, Record<string, Overwrite[]>>;
export interface Call {
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
export interface BodyRead {
	id: number;
	status: number;
	text: string;
}
export interface HeldBody {
	cancelled: string | null;
	id: number;
	release: () => void;
	released: boolean;
}
export interface HoldPlan {
	bearer: string;
	delegation: string;
	method: "GET" | "PUT";
	owner: Owner;
	path?: string;
	status: 200 | 503;
}
export const directory = await mkdtemp(
	join(tmpdir(), "ryu-resource-permissions-authority-")
);
export const stateFile = join(directory, "resource-acl-receipt.json");
export const calls: Call[] = [];
export const bodyStarts: number[] = [];
export const bodyReads: BodyRead[] = [];
export const heldBodies: HeldBody[] = [];
export const unexpected: string[] = [];
export const transportErrors: string[] = [];
export const runtimeErrors: string[] = [];
export const exchanges = new Set<Promise<Response>>();
export const observations = new Set<Promise<string>>();
export const unreadIds = new Set<number>();
export const waiters = new Set<() => void>();
export const artifacts = process.env.RYU_RESOURCE_PERMISSIONS_PROOF_ARTIFACTS;

export function originalRows(): Overwrite[] {
	return [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.edit"],
			deny: ["space.view"],
		},
	];
}
export function currentRows(): Overwrite[] {
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
export function editedRows(): Overwrite[] {
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
export function spaceRows(): Overwrite[] {
	return [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.view"],
			deny: [],
		},
	];
}
export function seed(): Records {
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
export function validRows(value: unknown): value is Overwrite[] {
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
export async function readPhysical(): Promise<Records> {
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
export async function publish(
	transform: (previous: Records | null) => Records
) {
	const temporary = join(directory, `resource-acl-${++live.publicationId}.tmp`);
	const operation = live.persistence.then(async () => {
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
			// Windows refuses to fsync a directory handle (EPERM) and NTFS journals
			// the rename, so only POSIX hosts sync the parent directory.
			if (process.platform !== "win32") {
				const parent = await open(directory, "r");
				try {
					await parent.sync();
				} finally {
					await parent.close();
				}
			}
		} finally {
			await rm(temporary, { force: true });
		}
	});
	// Each caller retains its actual publication failure. Only the queue tail
	// recovers so a later explicit write may retry without truncating a live GET.
	live.persistence = operation.catch(() => undefined);
	await operation;
}
export function notify() {
	for (const wake of [...waiters]) {
		wake();
	}
}
export function changed() {
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
export async function drain() {
	while (
		exchanges.size ||
		observations.size ||
		unreadIds.size ||
		live.activeHandlers
	) {
		const pending = [...exchanges, ...observations];
		if (pending.length) {
			await Promise.allSettled(pending);
		} else {
			await changed();
		}
	}
	await live.persistence;
}
export function heldSnapshot() {
	return heldBodies.map(({ id, released, cancelled }) => ({
		id,
		released,
		cancelled,
	}));
}
export function releaseAll() {
	for (const held of heldBodies) {
		held.release();
	}
}

export function credentials(
	owner: Owner,
	variant: "a" | "bearer" | "jwt" = "a"
) {
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
export function admittedCredentials(
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
export function vocabulary() {
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
export function principals(owner: Owner) {
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
export interface EditedResource {
	id: string;
	kind: "agent" | "space";
}
