import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(os.tmpdir(), "ryu-plugin-proof-"));
type Document = Record<string, string | null>;
interface Call {
	admitted: boolean;
	authority: string;
	authorization: string | null;
	buyerToken: string | null;
	completed: boolean;
	contentType: string | null;
	delegation: string | null;
	document?: Document;
	endpoint: string;
	id: number;
	method: string;
	preferenceValue?: string | null;
	query: string;
	rawBody: string;
	status: number;
}
let rawMutations: Array<{ authority: string; bytes: string; sha256: string }> =
	[];
let unexpectedNative: string[] = [];
let calls: Call[] = [];
let held: Array<{ id: number; release: () => void }> = [];
let next = 1;
let holdRead = false;
let refuseWrite = false;
// Plugin ids Core reports installed-but-disabled. Disabled plugins keep their
// roster record but contribute no companion, as Core's contributions endpoint does.
let disabledIds = new Set<string>();
function store(authority: string, value: Document) {
	storeRaw(authority, JSON.stringify(value));
}
function storeRaw(authority: string, bytes: string) {
	const file = path.join(directory, `${authority}.json`);
	writeFileSync(`${file}.new`, bytes);
	const fd = openSync(`${file}.new`, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(`${file}.new`, file);
	const parent = openSync(directory, "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}
function raw(authority: string): string {
	return readFileSync(path.join(directory, `${authority}.json`), "utf8");
}
function load(authority: string): Document {
	try {
		return JSON.parse(raw(authority));
	} catch {
		return null as unknown as Document;
	}
}
function rawReceipt(authority: string) {
	const bytes = raw(authority);
	return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function reset() {
	store("a", {
		"plugin:proof-shared": "Control+Alt+A",
		"plugin:proof-a-only": "Control+Alt+X",
		"chat.new": "Control+N",
	});
	store("b", {
		"plugin:proof-shared": "Control+Alt+B",
		"plugin:proof-b-unrelated": "Control+Alt+U",
		"chat.new": "Control+N",
	});
	calls = [];
	rawMutations = [];
	unexpectedNative = [];
	holdRead = false;
	refuseWrite = false;
	disabledIds = new Set();
}
reset();
const ids = (authority: string) => [
	"proof-shared",
	authority === "a" ? "proof-a-only" : "proof-b-unrelated",
];
const name = (authority: string, id: string) =>
	authority.toUpperCase() +
	" " +
	(id === "proof-shared" ? "Shared" : "Unrelated");
const app = (authority: string, id: string) => ({
	id,
	name: name(authority, id),
	version: "1.0.0",
	built_in: false,
	enabled: !disabledIds.has(id),
	installed: true,
	installed_version: "1.0.0",
	local_only: false,
	// Core's list_apps always injects this built-in projection field; the
	// shipping roster parser requires it.
	windows_first: false,
	permission_grants: [],
	runnables: [],
	sidecar_name: null,
	companion: {
		label: `${name(authority, id)} companion`,
		shortcut: "Control+Alt+D",
	},
});
function send(res: http.ServerResponse, status: number, body: unknown) {
	res.writeHead(status, {
		"content-type": "application/json",
		"access-control-allow-origin": "http://127.0.0.1:33368",
		"access-control-allow-headers":
			"authorization,content-type,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-ryu-user-id,x-ryu-user-name",
		"access-control-allow-methods": "GET,PUT,POST,OPTIONS",
	});
	res.end(JSON.stringify(body));
}
async function requestBody(req: http.IncomingMessage, limit: number) {
	let bytes = "";
	for await (const chunk of req) {
		bytes += chunk;
		if (Buffer.byteLength(bytes) > limit) {
			throw new Error("Bounded native request body required");
		}
	}
	return bytes;
}
function preferenceValue(body: unknown): string {
	if (
		body === null ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).length !== 1
	) {
		throw new Error("Exact native preference value envelope required");
	}
	const value: unknown = Reflect.get(body, "value");
	if (typeof value !== "string") {
		throw new Error("Exact native preference value envelope required");
	}
	return value;
}
function bindingsDocument(value: unknown): Document {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.values(value).some(
			(entry) => entry !== null && typeof entry !== "string"
		)
	) {
		throw new Error("Invalid plugin bindings document");
	}
	return value as Document;
}
const server = http.createServer(async (req, res) => {
	let activeCall: Call | undefined;
	try {
		const url = new URL(req.url!, "http://127.0.0.1:33367");
		if (req.method === "OPTIONS") {
			send(res, 204, {});
			return;
		}
		if (url.pathname === "/health") {
			send(res, 200, { ok: true });
			return;
		}
		if (url.pathname === "/control") {
			if (req.headers["x-fixture-control"] !== "plugin-control") {
				send(res, 403, {});
				return;
			}
			if (req.method === "POST") {
				let raw = "";
				for await (const chunk of req) {
					raw += chunk;
					if (raw.length > 4096) {
						throw new Error("Bounded control");
					}
				}
				const body = JSON.parse(raw);
				if (body.reset) {
					if (held.length || calls.some((call) => !call.completed)) {
						throw new Error("Pending calls");
					}
					reset();
				}
				if (body.rawDocument) {
					const { authority, bytes } = body.rawDocument;
					if (
						!["a", "b"].includes(authority) ||
						typeof bytes !== "string" ||
						Buffer.byteLength(bytes) > 65_536 ||
						held.length ||
						calls.some((call) => !call.completed)
					) {
						throw new Error("Bounded idle owned raw document required");
					}
					storeRaw(authority, bytes);
					rawMutations.push({
						authority,
						bytes,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					});
				}
				if (Array.isArray(body.releaseIds)) {
					const ids = body.releaseIds;
					if (
						ids.length > 16 ||
						ids.some((id: unknown) => !Number.isSafeInteger(id)) ||
						ids.some((id: number) => !held.some((item) => item.id === id))
					) {
						throw new Error("Exact held IDs required");
					}
					const pending = held.filter((item) => ids.includes(item.id));
					held = held.filter((item) => !ids.includes(item.id));
					for (const item of pending) {
						item.release();
					}
				}
				if ("holdRead" in body) {
					holdRead = body.holdRead;
				}
				if ("refuseWrite" in body) {
					refuseWrite = body.refuseWrite;
				}
				if ("disabledIds" in body) {
					const requested: unknown = body.disabledIds;
					if (
						!Array.isArray(requested) ||
						requested.some(
							(id) =>
								!["proof-shared", "proof-a-only", "proof-b-unrelated"].includes(
									id
								)
						)
					) {
						throw new Error("Declared plugin ids required");
					}
					disabledIds = new Set(requested);
				}
				if (body.release) {
					const pending = held;
					held = [];
					for (const item of pending) {
						item.release();
					}
				}
			}
			send(res, 200, {
				calls,
				unexpectedNative,
				held: held.map((item) => ({ id: item.id })),
				disk: { a: load("a"), b: load("b") },
				rawDisk: { a: rawReceipt("a"), b: rawReceipt("b") },
				rawMutations,
			});
			return;
		}
		const match = url.pathname.match(/^\/(a|b)(\/api\/.*)$/);
		if (!match) {
			unexpectedNative.push(`Undeclared native path ${req.method} ${url.href}`);
			send(res, 404, {});
			return;
		}
		const [, authority, endpoint] = match;
		const record: Call = {
			id: next++,
			authority,
			endpoint,
			method: req.method!,
			authorization: req.headers.authorization ?? null,
			delegation:
				typeof req.headers["x-ryu-user-jwt"] === "string"
					? req.headers["x-ryu-user-jwt"]
					: null,
			buyerToken:
				typeof req.headers["x-ryu-buyer-token"] === "string"
					? req.headers["x-ryu-buyer-token"]
					: null,
			contentType: req.headers["content-type"] ?? null,
			query: url.search,
			rawBody: "",
			status: 200,
			completed: false,
			admitted: false,
		};
		activeCall = record;
		calls.push(record);
		res.once("finish", () => {
			record.completed = true;
		});
		if (
			record.authorization !== `Bearer plugin-token-${authority}` ||
			req.headers["x-ryu-user-jwt"] !== undefined ||
			req.headers["x-ryu-buyer-token"] !== undefined
		) {
			unexpectedNative.push(
				`Undeclared native admission ${req.method} ${url.href}`
			);
			record.status = 401;
			send(res, 401, {});
			return;
		}
		record.rawBody = await requestBody(req, 65_536);
		if (
			record.query !== "" ||
			record.contentType !== "application/json" ||
			(req.method === "GET" && record.rawBody !== "")
		) {
			throw new Error(
				"Exact native query, content type and read body required"
			);
		}
		if (req.method === "GET" && endpoint === "/api/plugins") {
			send(res, 200, { apps: ids(authority).map((id) => app(authority, id)) });
			return;
		}
		if (req.method === "GET" && endpoint === "/api/plugins/contributions") {
			send(res, 200, {
				companions: ids(authority)
					.filter((id) => !disabledIds.has(id))
					.map((id) => ({
						id: `${id}-companion`,
						name: name(authority, id),
						label: `${name(authority, id)} companion`,
						plugin_id: id,
						shortcut: "Control+Alt+D",
					})),
			});
			return;
		}
		if (
			req.method === "GET" &&
			["/api/preferences/keybindings", "/api/preferences/dictation"].includes(
				endpoint
			)
		) {
			const key = decodeURIComponent(
				endpoint.slice("/api/preferences/".length)
			);
			const snapshot = key === "keybindings" ? raw(authority) : null;
			record.preferenceValue = snapshot;
			if (key === "keybindings" && holdRead) {
				holdRead = false;
				await new Promise<void>((release) =>
					held.push({ id: record.id, release })
				);
			}
			send(res, 200, { key, value: snapshot });
			return;
		}
		if (req.method === "PUT" && endpoint === "/api/preferences/keybindings") {
			const envelope: unknown = JSON.parse(record.rawBody);
			const parsed: unknown = JSON.parse(preferenceValue(envelope));
			const document = bindingsDocument(parsed);
			record.document = document;
			if (refuseWrite) {
				record.status = 503;
				send(res, 503, { error: "Owned plugin preference refusal" });
				return;
			}
			store(authority, document);
			record.admitted = true;
			send(res, 200, { ok: true, key: "keybindings" });
			return;
		}
		unexpectedNative.push(
			`Undeclared native endpoint ${req.method} ${url.href}`
		);
		record.status = 404;
		send(res, 404, { error: "Unauthorized plugin fixture endpoint" });
	} catch (error) {
		unexpectedNative.push(String(error));
		if (activeCall) {
			activeCall.status = 500;
		}
		send(res, 500, { error: String(error) });
	}
});
server.listen(33_367, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		for (const item of held) {
			item.release();
		}
		server.close(() => {
			rmSync(directory, { recursive: true });
			process.exit(0);
		});
	});
}
