// `ryu-cli secrets server --dev`: a one-shot development vault, like
// `bao server -dev`. It starts a Core on a loopback address with a fresh
// temporary data directory, prints how to point the CLI at it, and on Ctrl-C
// (or when Core exits) stops Core and deletes the directory.
//
// Safety rules:
// - Only the explicit `--dev` flag starts it; there is no environment switch.
// - `--bind` must be a loopback address (127.0.0.1, ::1 or localhost).
// - Core gets `RYU_DIR` set to the temporary directory and `RYU_KEYCHAIN=off`,
//   and inherits only an allowlist of process basics (no other `RYU_*`
//   variable, token, seal key or provider API key), so the real data
//   directory, the OS keychain and saved credentials are never touched.
// - Signal listeners are installed before the directory is created, so a
//   Ctrl-C while Core starts still stops Core and deletes the directory.
// - No root credential is printed: the loopback operator is trusted by Core,
//   and `/v1` tokens are minted with `ryu-cli secrets token create` as usual.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveCoreBinary } from "../core/bootstrap.ts";
import { cliDataDir } from "../core/cliStatePath.ts";
import { probeCore } from "../core/nodes.ts";
import { tf, tr } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { type CliContext, UsageError } from "./types.ts";

export const DEV_FLAG = "--dev";
export const DEFAULT_DEV_BIND = "127.0.0.1:8210";
const TEMP_PREFIX = "ryu-vault-dev-";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const STOP_GRACE_MS = 10_000;
/** Exit code when Ctrl-C stops Core before it is ready. */
export const INTERRUPTED_EXIT = 130;
/** The only inherited variables Core sees: what a process needs to run.
 *  Every other variable, including every other `RYU_*` name, node and
 *  gateway tokens, seal keys and provider API keys, is dropped. */
const INHERITED_ENV = new Set([
	"APPDATA",
	"COMSPEC",
	"HOME",
	"LANG",
	"LANGUAGE",
	"LOCALAPPDATA",
	"LOGNAME",
	"PATH",
	"PATHEXT",
	"RUST_BACKTRACE",
	"RUST_LIB_BACKTRACE",
	"RUST_LOG",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
	"USER",
	"USERPROFILE",
	"WINDIR",
]);

/** Whether the dev Core may inherit `key` from the caller's environment. */
export function isInheritedEnv(key: string): boolean {
	return INHERITED_ENV.has(key) || key.startsWith("LC_");
}

/** A running Core child. */
export interface DevCoreProcess {
	exited: Promise<number>;
	kill: (signal: "SIGTERM" | "SIGKILL") => void;
}

/** Host seams, so tests drive the lifecycle without a real Core. */
export interface DevServerHost {
	/** Start listening for Ctrl-C or SIGTERM: `stopped` resolves on the
	 *  first one, and `dispose` removes the listeners. */
	listenForStop: () => { dispose: () => void; stopped: Promise<void> };
	makeTempDir: () => Promise<string>;
	removeDir: (path: string) => Promise<void>;
	resolveCore: () => string | null;
	start: (
		bin: string,
		bind: string,
		env: Record<string, string>
	) => DevCoreProcess;
	/** Resolves true once Core answers at `url`, false on timeout or exit. */
	waitReady: (url: string, exited: Promise<number>) => Promise<boolean>;
}

/** Parse `--bind` and refuse anything but a loopback host with a valid port. */
export function loopbackBind(value: string): { bind: string; url: string } {
	const match = /^(\[::1\]|127\.0\.0\.1|localhost):(\d{1,5})$/.exec(
		value.trim()
	);
	const port = Number(match?.[2]);
	if (!match || port < 1 || port > 65_535) {
		throw new UsageError(
			tf(
				"The development server only binds a loopback address (127.0.0.1, [::1] or localhost) with a port; got {bind}.",
				{ bind: value }
			)
		);
	}
	const host = match[1] === "localhost" ? "127.0.0.1" : match[1];
	return { bind: `${host}:${port}`, url: `http://${host}:${port}` };
}

/** Whether `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return (
		rel === "" ||
		!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
	);
}

/** Core's environment: the allowlisted part of the caller's, on `dataDir`. */
export function devCoreEnv(
	base: Record<string, string | undefined>,
	dataDir: string
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && isInheritedEnv(key)) {
			env[key] = value;
		}
	}
	env.RYU_DIR = dataDir;
	env.RYU_KEYCHAIN = "off";
	env.RYU_PROFILE = "dev";
	return env;
}

async function stopCore(core: DevCoreProcess): Promise<void> {
	core.kill("SIGTERM");
	const timeout = new Promise<"timeout">((resolve) => {
		setTimeout(() => resolve("timeout"), STOP_GRACE_MS).unref?.();
	});
	if ((await Promise.race([core.exited, timeout])) === "timeout") {
		core.kill("SIGKILL");
		await core.exited;
	}
}

export function realDevServerHost(): DevServerHost {
	return {
		makeTempDir: async () =>
			realpath(await mkdtemp(join(tmpdir(), TEMP_PREFIX))),
		removeDir: (path) => rm(path, { force: true, recursive: true }),
		resolveCore: resolveCoreBinary,
		start: (bin, bind, env) => {
			const child = Bun.spawn({
				cmd: [bin, `--bind=${bind}`],
				env,
				stderr: "ignore",
				stdin: "ignore",
				stdout: "ignore",
			});
			return { exited: child.exited, kill: (signal) => child.kill(signal) };
		},
		waitReady: async (url, exited) => {
			let done = false;
			exited.then(() => {
				done = true;
			});
			const start = Date.now();
			while (!done && Date.now() - start < READY_TIMEOUT_MS) {
				if ((await probeCore({ token: null, url })) === "ready") {
					return true;
				}
				await Bun.sleep(READY_POLL_MS);
			}
			return false;
		},
		listenForStop: () => {
			let onSignal: () => void = () => undefined;
			const stopped = new Promise<void>((resolve) => {
				onSignal = () => resolve();
			});
			process.on("SIGINT", onSignal);
			process.on("SIGTERM", onSignal);
			return {
				dispose: () => {
					process.off("SIGINT", onSignal);
					process.off("SIGTERM", onSignal);
				},
				stopped,
			};
		},
	};
}

export async function devServer(
	ctx: CliContext,
	args: SecretsArgs,
	host: DevServerHost = realDevServerHost()
): Promise<number> {
	if (!args.booleans.has(DEV_FLAG)) {
		throw new UsageError(
			tr(
				"Only the development server is available: run 'ryu-cli secrets server --dev'."
			)
		);
	}
	const { bind, url } = loopbackBind(flag(args, "--bind") ?? DEFAULT_DEV_BIND);
	const bin = host.resolveCore();
	if (!bin) {
		throw new UsageError(
			tr(
				"ryu-core is not installed. Start the TUI once or set RYU_CORE_BIN to its path."
			)
		);
	}
	// Listen before anything is created, so a signal at any point (even while
	// Core starts) still runs the cleanup below instead of killing the CLI.
	const stop = host.listenForStop();
	try {
		return await runDevCore(ctx, host, { bin, bind, url }, stop.stopped);
	} finally {
		stop.dispose();
	}
}

/** Start Core on a fresh temporary directory and remove it however the run ends. */
async function runDevCore(
	ctx: CliContext,
	host: DevServerHost,
	target: { bin: string; bind: string; url: string },
	stopped: Promise<void>
): Promise<number> {
	const { bin, bind, url } = target;
	const dataDir = await host.makeTempDir();
	try {
		const realDir = cliDataDir(ctx.env);
		if (isInside(realDir, dataDir) || isInside(dataDir, realDir)) {
			throw new UsageError(
				tf(
					"The temporary directory {dir} overlaps the Ryu data directory; set TMPDIR elsewhere.",
					{ dir: dataDir }
				)
			);
		}
		ctx.io.err(
			`${tr("WARNING: development server. Data is temporary and deleted on exit, and loopback callers act as the operator. Never use it in production.")}\n`
		);
		const core = host.start(bin, bind, devCoreEnv(ctx.env, dataDir));
		try {
			const ready = await Promise.race([
				host.waitReady(url, core.exited),
				stopped.then(() => "stopped" as const),
			]);
			if (ready === "stopped") {
				return INTERRUPTED_EXIT;
			}
			if (!ready) {
				ctx.io.err(
					`${tf("Core did not start at {url} (is the port in use?).", { url })}\n`
				);
				return 1;
			}
			ctx.io.out(
				`${tf("Development vault ready at {url}. In another shell:", { url })}\n\n    export RYU_CORE_URL=${url}\n\n${tr("Press Ctrl-C to stop it and delete its data.")}\n`
			);
			await Promise.race([stopped, core.exited]);
			return 0;
		} finally {
			await stopCore(core);
		}
	} finally {
		await host.removeDir(dataDir);
	}
}
