// Ryu ↔ pi-ai OAuth login bridge.
//
// Drives one subscription login, credential refresh, or local model listing (`anthropic` /
// `openai-codex` / `github-copilot` / …) using pi-ai's own flow modules. JSONL
// over stdio lets Core surface login in the desktop and persist rotated tokens.
//
// Why a Node helper rather than three OAuth flows reimplemented in Rust: pi-ai
// already ships and maintains them (`dist/auth/oauth/*.js`), including Copilot's
// bespoke GitHub-device → Copilot-token exchange that Core deliberately refuses
// to guess at. Bridging the vendor flow keeps the
// client ids and endpoints out of Ryu entirely.
//
// This file is `include_str!`-embedded in Core and written into the managed Pi
// prefix (`~/.ryu/pi`) at runtime, so `@earendil-works/pi-ai` resolves from that
// tree's `node_modules`.
//
// Protocol — one JSON object per line.
//   stdout: {type:"auth_url", url, instructions?}
//           {type:"device_code", verificationUri, userCode}
//           {type:"progress"|"info", message}
//           {type:"prompt", id, prompt:{type, message, placeholder?, options?}}
//           {type:"done", credential:{…}}
//           {type:"error", message}
//   stdin:  {id, value}     — the answer to a "prompt" event
//           {type:"refresh", credential:{…}} — credential for refresh mode
//
// It deliberately does NOT write auth.json. The CLI this mirrors
// (`pi-ai/dist/cli.js`) writes a CWD-relative "auth.json", which would land the
// credential wherever Core happened to be started from. Core receives the
// credential on the "done" event and merges it into the managed Pi's auth.json
// itself, with the 0600 handling that file already gets.

import { createInterface } from "node:readline";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { proxiedFetch } from "./ryu-oauth-proxy.mjs";

// These native intrinsics admit only primitive JSON string fields; they neither
// coerce values nor accept boxed strings. Capture them before running a flow.
const intrinsicApply = Reflect.apply;
const intrinsicStringValue = String.prototype.valueOf;
const intrinsicBox = Object;

/** Admit exactly the bridge's consumed refresh fields; the SDK owns token metadata. */
function parseRefreshCredential(credential) {
	if (credential?.type !== "oauth") {
		return null;
	}
	const refresh = credential.refresh;
	if (intrinsicBox(refresh) === refresh) {
		return null;
	}
	try {
		intrinsicApply(intrinsicStringValue, refresh, []);
	} catch {
		return null;
	}
	return credential.refresh ? { credential } : null;
}

/** Classify only the documented revocation codes from an actual rejected reply. */
function classifyRefreshError(body) {
	const error = body?.error;
	let stringError = false;
	if (intrinsicBox(error) !== error) {
		try {
			intrinsicApply(intrinsicStringValue, error, []);
			stringError = true;
		} catch {
			/* Structured OAuth errors expose their code instead. */
		}
	}
	const code = stringError ? body.error : body?.error?.code;
	return [
		"invalid_grant",
		"refresh_token_reused",
		"refresh_token_revoked",
	].includes(code)
		? "revoked"
		: undefined;
}

// Provider route through the owner's desktop (see ryu-oauth-proxy.mjs).
if (process.env.RYU_OAUTH_PROXY_URL) {
	globalThis.fetch = proxiedFetch(process.env.RYU_OAUTH_PROXY_URL);
}

/** Emit one event. Every write is a single line — Core parses line-by-line. */
const emit = (event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

// Answers arrive asynchronously; each pending prompt parks here until its id
// comes back. Keyed by id so a flow that prompts twice cannot cross its answers.
const pending = new Map();
let nextPromptId = 0;
let acceptRefreshCredential;
let refreshFailure = "uncertain";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) {
		return;
	}
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (message.type === "refresh" && acceptRefreshCredential) {
		const accept = acceptRefreshCredential;
		acceptRefreshCredential = undefined;
		accept(message.credential);
		return;
	}
	const resolve = pending.get(message.id);
	if (resolve) {
		pending.delete(message.id);
		resolve(String(message.value ?? ""));
	}
});

/**
 * Ask Core for a value. The prompt object is forwarded VERBATIM — `options` in
 * particular must survive, because Copilot's flow asks a `select` and expects
 * one of the option ids back, not free text or an index.
 */
const prompt = (authPrompt) => {
	const id = `p${nextPromptId++}`;
	const { signal, ...visiblePrompt } = authPrompt;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			pending.delete(id);
			reject(signal.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		pending.set(id, (value) => {
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		});
		emit({ type: "prompt", id, prompt: visiblePrompt });
	});
};

const notify = (event) => {
	switch (event.type) {
		case "auth_url":
			emit({
				type: "auth_url",
				url: event.url,
				instructions: event.instructions,
			});
			break;
		case "device_code":
			emit({
				type: "device_code",
				verificationUri: event.verificationUri,
				userCode: event.userCode,
			});
			break;
		case "info":
		case "progress":
			emit({ type: event.type, message: event.message });
			break;
		default:
			break;
	}
};

/**
 * Hard ceiling on how long the bridge may linger after its terminal frame.
 *
 * Core reads this pipe in a tight loop, so a flush costs milliseconds — the
 * 200 KB `done` frame measured 36 ms end to end. Two seconds is therefore far
 * more headroom than a flush needs, while keeping the OAuth callback port held
 * for no longer than Core already waits for the bridge's exit status
 * (`EXIT_STATUS_WAIT` in oauth_login.rs).
 */
const EXIT_GRACE_MS = 2000;

/**
 * Exit, giving stdout a chance to go out first.
 *
 * `process.exit()` DISCARDS anything still queued on a piped stdout, and every
 * terminal frame this bridge writes is the one frame that matters: drop the
 * `done` line and Core sees only EOF, which it can report as nothing better
 * than "the login flow exited before completing" — for a login that in fact
 * succeeded. The `done` frame is also the biggest thing written here (it
 * carries the whole credential), so it is the one most likely to still be in
 * the pipe when the process leaves.
 *
 * What this does NOT do is wait for a `drain` event. That was the previous
 * shape and it was dead code for most partially-buffered writes: Node arms
 * `drain` only when a `write()` returned `false`, i.e. only once the buffer
 * reached the high-water mark, which for a piped stdout is 65536. Measured
 * here — four 30001-byte writes to a pipe with a slow reader — the last write
 * still returned `true` with `writableLength = 30001`, the buffer emptied, and
 * `drain` never fired. So the "NOT optional" exit silently degraded to whatever
 * the event loop did next.
 *
 * The exit really is not optional: these flows bind fixed callback ports (53692
 * for Claude, 1455 for ChatGPT), and pi-ai closes its callback server with
 * `server.close()`, which does not destroy live keep-alive sockets — so the
 * loop can stay alive holding the port. Hence: set the code, let the loop wind
 * down on its own when nothing holds it, and arm an UNREF'd timer as the
 * ceiling. Unref'd is the point — it never keeps the process alive itself, it
 * only fires when something else already has.
 *
 * The old fast path (`writableLength === 0` -> exit at once) is gone with it.
 * On macOS a piped stdout is written asynchronously and `writableLength` drops
 * to 0 the moment libuv takes the chunk, NOT when the reader has it, so that
 * test never proved what it was asked to prove. Dropping it trades an instant
 * exit for at most {@link EXIT_GRACE_MS}, and only when something is holding
 * the loop open; a truncated `done` frame costs the user a successful login
 * reported as a failure, which is the worse of the two by a wide margin.
 */
const exitWhenFlushed = (code) => {
	rl.close();
	process.exitCode = code;
	setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
};

async function main() {
	const providerId = process.argv[2];
	const mode = process.argv[3] ?? "login";
	if (!providerId) {
		emit({ type: "error", message: "no provider id given" });
		return 2;
	}
	if (mode === "models") {
		const provider = builtinProviders().find(
			(entry) => entry.id === providerId
		);
		// The pinned pi-ai0.84.4 Provider owner requires getModels(); builtinProviders
		// returns that installed owner, rather than an untrusted runtime plugin.
		if (!provider) {
			emit({ type: "error", message: "provider has no local model catalog" });
			return 2;
		}
		const models = await provider.getModels();
		emit({
			type: "models",
			models: models.slice(0, 512).flatMap((model) =>
				model.id.length <= 256
					? [
							{
								id: model.id,
								name: model.name.length <= 256 ? model.name : model.id,
							},
						]
					: []
			),
		});
		return 0;
	}
	const provider = builtinProviders().find(
		(entry) => entry.id === providerId && entry.auth?.oauth !== undefined
	);
	if (!provider) {
		emit({
			type: "error",
			message: `provider "${providerId}" has no OAuth login in this pi-ai build`,
		});
		return 2;
	}
	if (mode === "refresh") {
		const credential = await new Promise((resolve) => {
			acceptRefreshCredential = resolve;
		});
		const refreshInput = parseRefreshCredential(credential);
		if (!refreshInput) {
			emit({ type: "error", message: "invalid stored OAuth credential" });
			return 2;
		}
		// Observe an actual rejected response rather than guessing from exception
		// text (which can contain tokens). A lost response stays uncertain.
		const originalFetch = globalThis.fetch;
		let refreshMayHaveConsumed = false;
		globalThis.fetch = async (...args) => {
			refreshFailure = "uncertain";
			const response = await originalFetch(...args);
			if (response.ok) {
				refreshMayHaveConsumed = true;
			} else if (
				!refreshMayHaveConsumed &&
				(response.status === 429 || response.status === 503)
			) {
				refreshFailure = "transient";
			} else if (response.status === 400 || response.status === 401) {
				const body = await response
					.clone()
					.json()
					.catch(() => null);
				if (classifyRefreshError(body) === "revoked") {
					refreshFailure = "revoked";
				}
			}
			return response;
		};
		let refreshed;
		try {
			refreshed = await provider.auth.oauth.refresh(
				refreshInput.credential,
				new AbortController().signal
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
		emit({ type: "done", credential: refreshed });
		return 0;
	}
	if (mode !== "login") {
		emit({ type: "error", message: "unsupported OAuth bridge mode" });
		return 2;
	}
	// Pi's provider login contract requires a flow-wide AbortSignal. Claude's
	// callback flow uses it before emitting its authorization URL; without it,
	// login fails immediately at signal.addEventListener.
	const credential = await provider.auth.oauth.login({
		prompt,
		notify,
		signal: new AbortController().signal,
	});
	emit({ type: "done", credential });
	return 0;
}

main()
	.then((code) => exitWhenFlushed(code))
	.catch((error) => {
		// Vendor errors may embed refresh tokens or response bodies. Keep the
		// diagnostic useful without sending those bytes to Core logs or the UI.
		const detail = String(error?.message ?? "");
		const message = /EADDRINUSE/.test(detail)
			? "OAuth callback port is already in use"
			: /invalid_grant|revoked|expired/i.test(detail)
				? "OAuth credential expired or was revoked"
				: "Provider OAuth request failed";
		emit({ type: "error", message, refreshFailure });
		exitWhenFlushed(1);
	});
