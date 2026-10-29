import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://127.0.0.1:5606";
const root = process.env.SYNC_PROOF_CONTROL_ROOT;
if (!root) {
	throw new Error("Owned control directory is required");
}
await mkdir(root, { recursive: true });
const statePath = path.join(root, "durable-state.json");
interface Entry {
	deleted?: boolean;
	key: string;
	updatedAt: number;
	value: string | null;
}
interface Account {
	entries: Entry[];
	revision: number;
	updatedAt: number;
}
interface State {
	accounts: Record<string, Account>;
	otherShortcuts: string;
	shortcuts: string;
}
let state: State = {
	accounts: {
		A: { entries: [], revision: 0, updatedAt: 0 },
		B: { entries: [], revision: 0, updatedAt: 0 },
	},
	shortcuts: "{}",
	otherShortcuts: "{}",
};
interface Call {
	authorization: string | null;
	body: unknown;
	id: number;
	method: string;
	path: string;
	response?: unknown;
	settled: boolean;
}
let calls: Call[] = [];
let unexpected: string[] = [];
let holdPull = false;
let holdPushAck = false;
let refuseShortcut = false;
let refuseDelete = false;
const releases = new Map<number, () => void>();
async function persist() {
	await writeFile(statePath, JSON.stringify(state));
}
function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Headers":
				"authorization,content-type,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-ryu-user-id,x-ryu-user-name",
			"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
			"Cache-Control": "no-store",
			"Access-Control-Allow-Credentials": "true",
			Vary: "Origin",
		},
	});
}
function fail(message: string) {
	unexpected.push(message);
	return json({ error: message }, 400);
}
await persist();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 5607,
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname;
		const auth = req.headers.get("authorization");
		if (req.method === "OPTIONS") {
			const methods: Record<string, string[]> = {
				"/api/auth/token": ["GET"],
				"/core/api/preferences/keybindings": ["GET", "PUT"],
				"/other-core/api/preferences/keybindings": ["GET", "PUT"],
				"/api/desktop-settings-sync/pull": ["GET"],
				"/api/desktop-settings-sync/push": ["POST"],
				"/api/desktop-settings-sync": ["DELETE"],
			};
			const requested = (
				req.headers.get("access-control-request-headers") ?? ""
			)
				.toLowerCase()
				.split(",")
				.map((h) => h.trim())
				.filter(Boolean);
			const allowed = new Set(
				"authorization,content-type,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-ryu-user-id,x-ryu-user-name".split(
					","
				)
			);
			if (
				req.headers.get("origin") !== origin ||
				!methods[p]?.includes(
					req.headers.get("access-control-request-method") ?? ""
				) ||
				requested.some((h) => !allowed.has(h))
			) {
				return fail("Unexpected finite preflight contract");
			}
			return new Response(null, {
				status: 204,
				headers: {
					"Access-Control-Allow-Origin": origin,
					"Access-Control-Allow-Headers":
						"authorization,content-type,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-ryu-user-id,x-ryu-user-name",
					"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
					"Access-Control-Allow-Credentials": "true",
					Vary: "Origin",
				},
			});
		}
		if (p === "/proof/health" && req.method === "GET") {
			return json({ ready: true });
		}
		if (p.startsWith("/proof/")) {
			if (auth !== "Bearer owned-proof-control") {
				return fail("Unexpected proof authority");
			}
			if (p === "/proof/state" && req.method === "GET") {
				return json({
					state: JSON.parse(await readFile(statePath, "utf8")),
					calls,
					unexpected,
					pending: [...releases.keys()],
				});
			}
			if (p === "/proof/reset" && req.method === "POST") {
				if (releases.size) {
					return fail("Reset while an actual response remains held");
				}
				const b = (await req.json()) as {
					state: State;
					holdPull?: boolean;
					holdPushAck?: boolean;
					refuseShortcut?: boolean;
					refuseDelete?: boolean;
				};
				if (
					!(b.state?.accounts?.A && b.state?.accounts?.B) ||
					typeof b.state.shortcuts !== "string"
				) {
					return fail("Malformed seed");
				}
				state = b.state;
				calls = [];
				unexpected = [];
				holdPull = b.holdPull ?? false;
				holdPushAck = b.holdPushAck ?? false;
				refuseShortcut = b.refuseShortcut ?? false;
				refuseDelete = b.refuseDelete ?? false;
				await persist();
				return json({ ok: true });
			}
			if (p === "/proof/release" && req.method === "POST") {
				const b = (await req.json()) as { id: number };
				const release = releases.get(b.id);
				if (!release) {
					return fail("No exact held response");
				}
				releases.delete(b.id);
				release();
				return json({ ok: true });
			}
			if (p === "/proof/allow-shortcut" && req.method === "POST") {
				refuseShortcut = false;
				return json({ ok: true });
			}
			if (p === "/proof/allow-delete" && req.method === "POST") {
				refuseDelete = false;
				return json({ ok: true });
			}
			return fail("Unknown proof endpoint");
		}
		if (req.headers.get("origin") !== origin) {
			return fail("Unexpected browser origin");
		}
		const body = ["PUT", "POST"].includes(req.method) ? await req.json() : null;
		const call: Call = {
			id: calls.length + 1,
			method: req.method,
			path: p + url.search,
			authorization: auth,
			body,
			settled: false,
		};
		calls.push(call);
		const finish = (value: unknown, status = 200) => {
			call.settled = true;
			call.response = structuredClone(value);
			return json(value, status);
		};
		if (
			p === "/core/api/preferences/keybindings" ||
			p === "/other-core/api/preferences/keybindings"
		) {
			const other = p.startsWith("/other-core/");
			const slot = other ? "otherShortcuts" : "shortcuts";
			if (auth !== (other ? "Bearer owned-core-B" : "Bearer owned-core")) {
				return fail("Unexpected Core authority");
			}
			if (
				!["owned-proof-realtime-A", "owned-proof-realtime-B"].includes(
					req.headers.get("x-ryu-user-jwt") ?? ""
				)
			) {
				return fail("Unexpected finite Core user identity");
			}
			if (req.method === "GET") {
				return finish({
					key: "keybindings",
					value: JSON.parse(await readFile(statePath, "utf8"))[slot],
				});
			}
			if (req.method === "PUT") {
				if (
					typeof (body as { value?: unknown })?.value !== "string" ||
					Object.keys(body as object).join() !== "value"
				) {
					return fail("Unexpected shortcut payload");
				}
				if (refuseShortcut) {
					return finish({ error: "Owned shortcut save refused" }, 503);
				}
				state[slot] = (body as { value: string }).value;
				await persist();
				return finish({ key: "keybindings", value: state[slot] });
			}
			return fail("Unknown shortcut method");
		}
		const account =
			auth === "Bearer account-A"
				? "A"
				: auth === "Bearer account-B"
					? "B"
					: null;
		if (!account) {
			return fail("Unexpected account authority");
		}
		if (p === "/api/auth/token" && req.method === "GET" && url.search === "") {
			return finish({ token: `owned-proof-realtime-${account}` });
		}
		const document = state.accounts[account];
		if (!document) {
			return fail("Missing owned account");
		}
		if (p === "/api/desktop-settings-sync/pull" && req.method === "GET") {
			if (
				[...url.searchParams.keys()].join() !== "since" ||
				!Number.isFinite(Number(url.searchParams.get("since")))
			) {
				return fail("Unexpected cursor");
			}
			const since = Number(url.searchParams.get("since"));
			const snapshot = structuredClone({
				entries: document.entries.filter((e) => e.updatedAt >= since),
				revision: document.revision,
				updatedAt: document.updatedAt,
			});
			if (holdPull) {
				holdPull = false;
				await new Promise<void>((resolve) => releases.set(call.id, resolve));
			}
			return finish(snapshot);
		}
		if (p === "/api/desktop-settings-sync/push" && req.method === "POST") {
			const entries = (body as { entries?: Entry[] })?.entries;
			if (
				!Array.isArray(entries) ||
				Object.keys(body as object).join() !== "entries" ||
				entries.some(
					(e) =>
						typeof e.key !== "string" ||
						typeof e.updatedAt !== "number" ||
						(typeof e.value !== "string" && e.deleted !== true)
				)
			) {
				return fail("Unexpected push payload");
			}
			if (entries.length > 500) {
				return finish({ error: "at most 500 entries per push" }, 400);
			}
			const validEntries = entries.filter(
				(e) =>
					e.key.length > 0 &&
					new TextEncoder().encode(e.key).byteLength <= 256 &&
					Number.isFinite(e.updatedAt) &&
					(e.deleted === true ||
						new TextEncoder().encode(e.value as string).byteLength <=
							128 * 1024)
			);
			const applied: string[] = [];
			const rejected: Entry[] = [];
			for (const incoming of validEntries) {
				const old = document.entries.find((e) => e.key === incoming.key);
				if (old && old.updatedAt >= incoming.updatedAt) {
					if (old.updatedAt > incoming.updatedAt) {
						rejected.push(old);
					}
					continue;
				}
				document.entries = document.entries.filter(
					(e) => e.key !== incoming.key
				);
				document.entries.push({
					...incoming,
					deleted: incoming.deleted === true,
				});
				applied.push(incoming.key);
			}
			if (applied.length) {
				document.revision++;
				document.updatedAt = Math.max(
					document.updatedAt,
					...document.entries.map((e) => e.updatedAt)
				);
				await persist();
			}
			// The old draft is physically saved before its acknowledgment is released.
			const acknowledgment = structuredClone({
				applied,
				rejected,
				updatedAt: document.updatedAt,
				revision: document.revision,
			});
			if (holdPushAck) {
				holdPushAck = false;
				await new Promise<void>((resolve) => releases.set(call.id, resolve));
			}
			return finish(acknowledgment);
		}
		if (p === "/api/desktop-settings-sync" && req.method === "DELETE") {
			if (refuseDelete) {
				return finish({ error: "Owned deletion refused" }, 503);
			}
			state.accounts[account] = { entries: [], revision: 0, updatedAt: 0 };
			await persist();
			return finish({ ok: true });
		}
		return fail("Unknown shipping endpoint/method");
	},
});
console.log(`Owned settings sync backend ${server.url} state ${statePath}`);
