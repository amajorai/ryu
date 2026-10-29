import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	renameSync,
	openSync,
	fsyncSync,
	closeSync,
} from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
interface Payload {
	version: number;
	mode: string;
	lightPreset: string;
	darkPreset: string;
	contrast: number;
	radius: number;
	customThemes: Array<{
		id: string;
		label: string;
		mode: string;
		tokens: Record<string, string>;
	}>;
	[key: string]: unknown;
}
interface Call {
	id: number;
	method: string;
	path: string;
	authorization: string | null;
	status: number;
	admitted: boolean;
	completed: boolean;
	payload?: Payload;
}
interface State {
	calls: Call[];
	preference: Payload | null;
}
export function themePublisherHttp(): Plugin {
	const directory = process.env.RYU_APPEARANCE_PUBLISHER_DATA;
	if (!directory || !path.isAbsolute(directory))
		throw new Error("Fresh owned publisher data path required");
	const file = path.join(directory, "ledger.json");
	let state: State = { calls: [], preference: null };
	let next = 1;
	function save() {
		writeFileSync(file + ".new", JSON.stringify(state));
		const fd = openSync(file + ".new", "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(file + ".new", file);
		const parent = openSync(directory, "r");
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	}
	function read(): State {
		return JSON.parse(readFileSync(file, "utf8"));
	}
	function send(res: ServerResponse, status: number, body: unknown) {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}
	async function body(req: IncomingMessage, max: number) {
		let text = "";
		for await (const chunk of req) {
			text += chunk;
			if (Buffer.byteLength(text) > max)
				throw Error("Bounded publisher request exceeded");
		}
		return JSON.parse(text);
	}
	function validate(value: unknown): Payload {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw Error("ThemePrefs object required");
		const prefs = value as Payload;
		if (
			prefs.version !== 1 ||
			!["light", "dark", "system"].includes(prefs.mode) ||
			typeof prefs.lightPreset !== "string" ||
			typeof prefs.darkPreset !== "string" ||
			!Number.isFinite(prefs.contrast) ||
			!Number.isFinite(prefs.radius) ||
			!Array.isArray(prefs.customThemes) ||
			prefs.customThemes.length > 16
		)
			throw Error("Invalid actual ThemePrefs shape");
		for (const theme of prefs.customThemes) {
			if (
				!theme ||
				typeof theme.id !== "string" ||
				typeof theme.label !== "string" ||
				!["light", "dark"].includes(theme.mode) ||
				typeof theme.tokens !== "object" ||
				theme.tokens === null ||
				Object.entries(theme.tokens).some(
					([key, value]) => !key.startsWith("--") || typeof value !== "string",
				)
			)
				throw Error("Invalid inline theme variant");
		}
		return prefs;
	}
	return {
		name: "owned-native-theme-publisher",
		configureServer(server) {
			mkdirSync(directory, { recursive: false });
			save();
			server.middlewares.use((req, res, nextMiddleware) => {
				const url = new URL(req.url!, "http://127.0.0.1:33364");
				if (
					!url.pathname.startsWith("/api/") &&
					url.pathname !== "/__appearance-publisher/control"
				) {
					nextMiddleware();
					return;
				}
				let requestCall: Call | undefined;
				void (async () => {
					if (url.pathname === "/__appearance-publisher/control") {
						if (
							req.headers["x-fixture-control"] !==
							"appearance-publisher-control"
						) {
							send(res, 403, { error: "Control denied" });
							return;
						}
						if (req.method === "POST") {
							const data = await body(req, 4096);
							if (
								!data ||
								data.reset !== true ||
								Object.keys(data).length !== 1
							)
								throw Error("Exact reset control required");
							if (state.calls.some((call) => !call.completed)) {
								send(res, 409, { error: "Publisher not settled" });
								return;
							}
							state = { calls: [], preference: null };
							save();
						} else if (req.method !== "GET") {
							send(res, 405, {});
							return;
						}
						send(res, 200, read());
						return;
					}
					const call: Call = {
						id: next++,
						method: req.method!,
						path: url.pathname,
						authorization: req.headers.authorization ?? null,
						status: 200,
						admitted: false,
						completed: false,
					};
					requestCall = call;
					state.calls.push(call);
					save();
					res.once("finish", () => {
						call.completed = true;
						save();
					});
					if (
						url.pathname !== "/api/preferences/theme" ||
						req.method !== "PUT"
					) {
						call.status = 404;
						save();
						send(res, 404, { error: "Unauthorized appearance endpoint" });
						return;
					}
					if (call.authorization !== "Bearer appearance-proof") {
						call.status = 401;
						save();
						send(res, 401, { error: "Wrong appearance publisher authority" });
						return;
					}
					const envelope = await body(req, 512 * 1024);
					if (
						!envelope ||
						typeof envelope.value !== "string" ||
						Object.keys(envelope).length !== 1
					)
						throw Error("Actual {value:string} preferences protocol required");
					const payload = validate(JSON.parse(envelope.value));
					call.payload = payload;
					call.admitted = true;
					state.preference = payload;
					save();
					send(res, 200, { key: "theme", value: envelope.value });
				})().catch((error) => {
					if (requestCall) {
						requestCall.status = 500;
						save();
					}
					send(res, 500, { error: String(error) });
				});
			});
		},
	};
}
