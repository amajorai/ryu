import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const apiPort = 5866;
const uiOrigin = "http://127.0.0.1:5291";
const dataRoot = process.env.RYU_VOICE_OUTCOMES_DATA_ROOT;
if (!(dataRoot && path.isAbsolute(dataRoot) && dataRoot.startsWith("/tmp/"))) {
	throw new Error("Explicit owned temporary data root required");
}
fs.mkdirSync(dataRoot, { recursive: true });
const initial = () => ({
	models: [
		{
			default: true,
			display_name: "Kokoro finite model",
			engine: "kokoro",
			engine_display_name: "Kokoro",
			hf_repo_id: "finite/example",
			installed: false,
			languages: ["en"],
			model_name: "kokoro-finite-model",
			size_mb: 1,
		},
		{
			default: false,
			display_name: "Pocket finite model",
			engine: "pocket",
			engine_display_name: "Pocket",
			hf_repo_id: "finite/pocket",
			installed: false,
			languages: ["en"],
			model_name: "pocket-finite-model",
			size_mb: 2,
		},
	],
	runtimeInstalled: true,
	runtimeRunning: false,
});
const initialControls = () => ({
	failModelInstall: 0,
	holdModelInstall: false,
	failModelsRead: 0,
	failRuntimeInstall: 0,
	refuseStart: false,
	failStatusRead: 0,
	holdModelsRead: 0,
	holdStatusRead: 0,
	holdAcceptedModelAck: 0,
});
const sessions = new Map(
	["a", "b", "rotated"].map((authority) => [
		authority,
		{
			authority,
			state: initial(),
			controls: initialControls(),
			file: path.join(
				dataRoot,
				authority === "a"
					? "finite-native-state.json"
					: `authority-${authority}.json`
			),
		},
	])
);
let calls = [];
let held = [];
let nextHeld = 1;
function persist(session) {
	const temp = `${session.file}.tmp`;
	const fd = fs.openSync(temp, "w", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(session.state));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(temp, session.file);
	const dir = fs.openSync(dataRoot, "r");
	try {
		fs.fsyncSync(dir);
	} finally {
		fs.closeSync(dir);
	}
}
for (const session of sessions.values()) {
	if (fs.existsSync(session.file)) {
		session.state = JSON.parse(fs.readFileSync(session.file, "utf8"));
	}
	persist(session);
}
const catalog = (state) =>
	["ryutts", "audiocpp"].map((name) => ({
		name,
		display_name: name === "ryutts" ? "Ryu Audio engine" : "audio.cpp runtime",
		category: "voice",
		description: "Finite installed runtime contract",
		deprecated: false,
		installed_version:
			name === "ryutts" && state.runtimeInstalled ? "1.0.0" : null,
		install_state:
			name === "ryutts" && state.runtimeInstalled
				? "installed"
				: "not_installed",
		latest_version: "1.0.0",
		platforms: [],
		recommended: true,
		supported: true,
		update_available: false,
	}));
function respond(res, status, body) {
	if (res.fixtureCall) {
		res.fixtureCall.status = status;
		res.fixtureCall.responseBody = structuredClone(body);
	}
	res.writeHead(status, {
		"content-type": "application/json",
		"access-control-allow-origin": uiOrigin,
		"access-control-allow-headers": "authorization,content-type,x-ryu-user-jwt",
		"access-control-allow-methods": "GET,POST,OPTIONS",
	});
	res.end(JSON.stringify(body));
}
async function hold(session, route) {
	await new Promise((resolve) =>
		held.push({
			id: nextHeld++,
			authority: session.authority,
			path: route,
			release: resolve,
		})
	);
}
function snapshot() {
	const a = sessions.get("a");
	return {
		state: structuredClone(a.state),
		disk: JSON.parse(fs.readFileSync(a.file, "utf8")),
		calls,
		held: held.length,
		heldReceipts: held.map(({ id, authority, path }) => ({
			id,
			authority,
			path,
		})),
		authorities: Object.fromEntries(
			[...sessions].map(([key, s]) => [
				key,
				{
					state: structuredClone(s.state),
					disk: JSON.parse(fs.readFileSync(s.file, "utf8")),
				},
			])
		),
	};
}
const server = http.createServer(async (req, res) => {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 16_384) {
			respond(res, 413, { error: "Bounded fixture body exceeded" });
			return;
		}
	}
	let body;
	try {
		body = raw ? JSON.parse(raw) : null;
	} catch {
		respond(res, 400, { error: "Invalid JSON" });
		return;
	}
	const rawPath = new URL(req.url, `http://127.0.0.1:${apiPort}`).pathname;
	if (req.method === "OPTIONS") {
		respond(res, 204, {});
		return;
	}
	if (rawPath === "/health" && req.method === "GET") {
		respond(res, 200, { ok: true });
		return;
	}
	if (rawPath === "/control") {
		if (req.headers["x-fixture-control"] !== "local-voice-outcomes-control") {
			respond(res, 403, { error: "Control denied" });
			return;
		}
		if (req.method === "POST") {
			if (body?.reset) {
				if (held.length) {
					respond(res, 409, {
						error: "Held operations must settle before reset",
					});
					return;
				}
				for (const session of sessions.values()) {
					session.state = initial();
					session.controls = initialControls();
				}
				const a = sessions.get("a");
				a.state = { ...a.state, ...body.state };
				a.controls = { ...a.controls, ...body.controls };
				calls = [];
				for (const session of sessions.values()) {
					persist(session);
				}
			} else if (body?.release) {
				for (const session of sessions.values()) {
					session.controls.holdModelInstall = false;
				}
				const selected = held.filter(
					(h) => body.id === undefined || h.id === body.id
				);
				held = held.filter((h) => !selected.includes(h));
				for (const h of selected) {
					h.release();
				}
			} else {
				const session = sessions.get(body?.authority ?? "a");
				if (!session) {
					respond(res, 400, { error: "Unknown controlled authority" });
					return;
				}
				if (body?.setState) {
					session.state = {
						...session.state,
						...structuredClone(body.setState),
					};
					persist(session);
				}
				for (const [key, value] of Object.entries(body ?? {})) {
					if (key in session.controls) {
						session.controls[key] = value;
					}
				}
			}
		}
		respond(res, 200, snapshot());
		return;
	}
	const prefix = rawPath.startsWith("/b/") ? "b" : null;
	const pathname = prefix ? rawPath.slice(2) : rawPath;
	const bearer = req.headers.authorization;
	const authority =
		prefix === "b" && bearer === "Bearer finite-voice-outcomes-token-b"
			? "b"
			: !prefix && bearer === "Bearer finite-voice-outcomes-token"
				? "a"
				: !prefix && bearer === "Bearer finite-voice-outcomes-token-rotated"
					? "rotated"
					: null;
	const call = {
		method: req.method,
		path: pathname,
		rawPath,
		authority,
		authorizationAccepted: authority !== null,
		body,
		status: null,
		finished: false,
		disconnected: false,
	};
	calls.push(call);
	res.fixtureCall = call;
	res.on("finish", () => {
		call.finished = true;
	});
	res.on("close", () => {
		if (!res.writableFinished) {
			call.disconnected = true;
		}
	});
	if (!authority) {
		respond(res, 401, { error: "Native fixture admission refused" });
		return;
	}
	const session = sessions.get(authority);
	const controls = session.controls;
	if (req.method === "GET" && pathname === "/api/catalog") {
		respond(res, 200, { sidecars: catalog(session.state) });
		return;
	}
	if (req.method === "GET" && pathname === "/api/sidecar/status") {
		if (controls.failStatusRead-- > 0) {
			respond(res, 503, { error: "Finite runtime status unreadable" });
			return;
		}
		const payload = {
			sidecars: [
				{ name: "ryutts", running: session.state.runtimeRunning },
				{ name: "audiocpp", running: false },
			],
		};
		call.admittedSnapshot = structuredClone(payload);
		if (controls.holdStatusRead-- > 0) {
			await hold(session, pathname);
		}
		respond(res, 200, payload);
		return;
	}
	if (req.method === "GET" && pathname === "/api/voice/tts-engines") {
		respond(res, 200, {
			data: [
				{
					id: "kokoro",
					display_name: "Kokoro",
					description: "Finite speech-engine contract",
					default_voice: "af_heart",
					installed:
						session.state.runtimeInstalled && session.state.runtimeRunning,
					loaded: session.state.runtimeRunning,
					languages: ["en"],
					sample_rate: 24_000,
					size_mb: 1,
					supports_cloning: false,
					voices: ["af_heart"],
				},
			],
		});
		return;
	}
	if (req.method === "GET" && pathname === "/api/voice/tts-models") {
		if (controls.failModelsRead-- > 0) {
			respond(res, 503, { error: "Finite model inventory unreadable" });
			return;
		}
		const payload = { data: structuredClone(session.state.models) };
		call.admittedSnapshot = structuredClone(payload);
		if (controls.holdModelsRead-- > 0) {
			await hold(session, pathname);
		}
		respond(res, 200, payload);
		return;
	}
	if (req.method === "POST" && pathname === "/api/voice/tts-models/install") {
		const selected = session.state.models.find(
			(m) => m.engine === body?.engine && m.model_name === body?.model_name
		);
		if (
			!selected ||
			Object.keys(body ?? {})
				.sort()
				.join(",") !== "engine,model_name"
		) {
			respond(res, 400, { error: "Exact known model identity required" });
			return;
		}
		if (controls.failModelInstall-- > 0) {
			respond(res, 503, { error: "Finite model download refused" });
			return;
		}
		if (controls.holdModelInstall) {
			await hold(session, pathname);
		}
		// Captured session only, even if browser authority changes while the response is held.
		selected.installed = true;
		persist(session);
		if (controls.holdAcceptedModelAck-- > 0) {
			await hold(session, pathname);
		}
		respond(res, 200, { ok: true });
		return;
	}
	if (req.method === "POST" && pathname === "/api/setup/ryutts/install") {
		if (controls.failRuntimeInstall-- > 0) {
			respond(res, 503, { error: "Finite runtime download refused" });
			return;
		}
		session.state.runtimeInstalled = true;
		persist(session);
		// Core's setup install route always answers with `forced` and `message`.
		respond(res, 200, {
			success: true,
			forced: false,
			message: "Sidecar 'ryutts' installation started in background",
		});
		return;
	}
	if (req.method === "POST" && pathname === "/api/sidecar/ryutts/start") {
		if (controls.refuseStart) {
			respond(res, 200, {
				success: false,
				error: "Finite runtime start refused",
			});
			return;
		}
		if (!session.state.runtimeInstalled) {
			respond(res, 409, { success: false, error: "Runtime not installed" });
			return;
		}
		session.state.runtimeRunning = true;
		persist(session);
		respond(res, 200, { success: true });
		return;
	}
	respond(res, 404, {
		error: `Unsupported finite route ${req.method} ${pathname}`,
	});
});
server.listen(apiPort, "127.0.0.1", () =>
	process.stdout.write(`Finite voice outcomes HTTP ${apiPort}\n`)
);
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		for (const h of held.splice(0)) {
			h.release();
		}
		server.close(() => process.exit(0));
		server.closeAllConnections();
	});
}
