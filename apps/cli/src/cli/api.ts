import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
// The real {@link CoreApi} bundle: the typed core-client plugin-lifecycle calls
// plus the tui's own SSE chat client. Handlers receive this via the CliContext, so
// nothing here is imported by them directly — that indirection is the test seam
// (bun tests pass a fake CoreApi and never touch the network). The `ryu init`
// scaffold runner rides the same seam for the same reason: it is injected, so the
// tests exercise the command without ever spawning a process.

import {
	type ActionCallInput,
	type ActionCallResult,
	callAction,
} from "@ryuhq/core-client/actions";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "@ryuhq/core-client/client";
import {
	disableApp,
	enableApp,
	fetchApps,
	fetchAppsCatalog,
	installApp,
	isSafeCommandPath,
	previewAppLifecycle,
	uninstallApp,
} from "@ryuhq/core-client/plugins";
import { streamChat } from "../core/chatStream.ts";
import { LocalizedError, localize } from "./localizedText.ts";
import type {
	CoreApi,
	ProcessRunner,
	ScaffoldResult,
	ScaffoldRunner,
} from "./types.ts";

/** HTTP verbs that carry a request body; the rest encode args in the query. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Route one `ryu <app> <cmd> [args…]` call to the app's sidecar through Core's
 *  generic `ext_proxy` (`/api/ext/<pluginId><path>`). Args-passthrough convention:
 *  body methods send `{ args }` as JSON; query methods append
 *  `?args=<json>`. Never throws on a non-2xx — returns the raw status + text so
 *  the dispatcher owns the exit-code mapping. */
async function execAppCommand(
	target: ApiTarget,
	pluginId: string,
	cmd: { method: string; path: string },
	args: string[]
): Promise<{ body: string; status: number }> {
	// Defence-in-depth (the manifest loader + toAppCommands already drop unsafe
	// paths): never build a request URL from a traversal path. A `..`/`%2e`/`\`
	// path would be normalized by the URL parser to escape `/api/ext/<id>/` and hit
	// an arbitrary internal route with the node bearer — refuse it before fetch.
	if (!isSafeCommandPath(cmd.path)) {
		return {
			status: 400,
			body: `refusing to run command: unsafe path '${cmd.path}'`,
		};
	}
	const method = cmd.method.toUpperCase();
	const hasBody = BODY_METHODS.has(method);
	const path = hasBody
		? `/api/ext/${pluginId}${cmd.path}`
		: `/api/ext/${pluginId}${cmd.path}?args=${encodeURIComponent(JSON.stringify(args))}`;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method,
		headers: makeHeaders(target.token, target.userJwt),
		body: hasBody ? JSON.stringify({ args }) : undefined,
	});
	return { status: resp.status, body: await resp.text() };
}

/** The scaffolder invoked by `ryu init`, as a user would run it themselves.
 *  `create-ryu-app` owns every template; shelling out keeps it that way — importing
 *  it would give the tui a build-time dependency on a package it does not own and
 *  would freeze that package's template list into this binary at release time, so a
 *  template added upstream would silently not exist here. */
const SCAFFOLD_CMD = ["bunx", "create-ryu-app"];

/** Env override for the scaffolder command, mirroring the `RYU_*_BIN` convention
 *  the Core/Gateway bootstrap already uses (see core/bootstrap.ts). Lets a monorepo
 *  or air-gapped checkout point `ryu init` at a local build instead of the npm
 *  registry, without the command layer growing a second code path. */
function scaffoldCommand(): string[] {
	const override = process.env.RYU_CREATE_APP_BIN;
	return override ? [override] : SCAFFOLD_CMD;
}

/** Spawn the scaffolder and CAPTURE its output (never inherit — see
 *  {@link ScaffoldResult}). `argv` elements are passed as separate arguments with
 *  no shell, so a project name can never be interpreted as a command. A spawn
 *  failure (no Bun on PATH) is rethrown with the fix in the message rather than a
 *  bare ENOENT, since that is the one failure a user can actually act on. */
const runScaffold: ScaffoldRunner = async (
	argv: string[]
): Promise<ScaffoldResult> => {
	const cmd = [...scaffoldCommand(), ...argv];
	// The stdio generics are spelled out so `proc.stdout`/`proc.stderr` type as the
	// piped ReadableStreams they are, not the union `Bun.spawn` widens to.
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn({
			cmd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		// Point at whichever half the user actually controls: a broken override is a
		// different fix from a missing Bun, and a message naming the wrong one sends
		// them off installing something they already have.
		const fix = process.env.RYU_CREATE_APP_BIN
			? localize("Check RYU_CREATE_APP_BIN.")
			: localize(
					"Install Bun (https://bun.sh), or set RYU_CREATE_APP_BIN to a local scaffolder."
				);
		throw new LocalizedError(
			localize("could not run '{command}': {error}. {fix}", {
				command: cmd[0],
				error: String(err),
				fix,
			})
		);
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

/** Run a child with inherited stdio and an explicit environment (`ryu secrets
 *  run`). The argv is passed without a shell, so values in the environment are
 *  never interpolated into a command line, and nothing here prints them. */
export const runProcess: ProcessRunner = async (cmd, env) => {
	let proc: Bun.Subprocess<"inherit", "inherit", "inherit">;
	try {
		proc = Bun.spawn({
			cmd,
			env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
	} catch (err) {
		throw new LocalizedError(
			localize("could not run '{command}': {error}", {
				command: cmd[0],
				error: String(err),
			})
		);
	}
	return await proc.exited;
};

/** Read piped stdin as text; null when stdin is an interactive terminal. */
export async function readStdin(): Promise<string | null> {
	if (process.stdin.isTTY) {
		return null;
	}
	return await Bun.stdin.text();
}

/**
 * Ask one question on the terminal; null when stdin or stdout is not an
 * interactive terminal, or when input ends (Ctrl+D / Ctrl+C), so an
 * interactive command can stop instead of acting on an answer never given.
 */
export async function promptLine(question: string): Promise<string | null> {
	if (!(process.stdin.isTTY && process.stdout.isTTY)) {
		return null;
	}
	const { createInterface } = await import("node:readline/promises");
	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const ended = new Promise<null>((resolve) => {
		readline.once("close", () => resolve(null));
	});
	try {
		return await Promise.race([readline.question(question), ended]);
	} catch {
		return null;
	} finally {
		readline.close();
	}
}

/** The production CoreApi wired to a live Core node over HTTP. */
export const realCoreApi: CoreApi = {
	callAction: (
		target: ApiTarget,
		actionId: string,
		input: ActionCallInput
	): Promise<ActionCallResult> => callAction(target, actionId, input),
	call: (target, path, options) =>
		request(target, path, options, appResponseValueSchema),
	disableApp,
	enableApp,
	execAppCommand,
	fetchApps,
	fetchAppsCatalog,
	installApp,
	previewAppLifecycle,
	streamChat,
	uninstallApp,
};

/** The production scaffold runner, injected alongside {@link realCoreApi}. */
export const realScaffold: ScaffoldRunner = runScaffold;
