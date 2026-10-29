#!/usr/bin/env bun
/* @jsxImportSource @opentui/react */
// Entry point for the Ryu TUI. Boots the OpenTUI renderer and mounts <App/>.
//
// We disable exitOnCtrlC so the shell can route Ctrl+C through renderer.destroy()
// (the only correct way to quit - process.exit() leaves the terminal in raw mode
// with the alternate screen still active). The Core node is resolved once
// (`--node`, else RYU_CORE_URL / RYU_CORE_TOKEN, else the saved active node; see
// core/nodeTarget.ts) and handed to the provider.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type ApiTarget, setSurfaceProvider } from "@ryuhq/core-client/client";
import { App } from "./App.tsx";
import { requiresWaitlistAccess } from "./cli/access.ts";
import { isInteractive, parseArgs, runCli } from "./cli/dispatch.ts";
import { ensureCoreRunning } from "./core/bootstrap.ts";
import { herdrReporter } from "./core/herdr.ts";
import { installCliIdentity } from "./core/identity.ts";
import { resolveNodeTarget } from "./core/nodeTarget.ts";
import { reportCliReferralEvent } from "./core/quest-events.ts";
import {
	runCliAutoUpdate,
	startCliAutoUpdate,
	startCliAutoUpdateWorker,
} from "./core/self-update.ts";
import { buildInteractiveTarget, buildTarget } from "./core/target.ts";
import { resolveCliWaitlistAccess } from "./core/waitlist.ts";

// Declare the calling surface once, at entry, so EVERY core-client request carries
// `X-Ryu-Surface: cli` (makeHeaders reads the provider). Core filters the plugin
// list/catalog/contributions to what actually targets this surface; without it the
// list is unfiltered. The TUI is a terminal client to a Core node, so "cli" is the
// natural token (it shares that surface vocabulary with apps/cli). Mirrors the
// setBuyerTokenProvider precedent — the shared client never hardcodes a surface.
setSurfaceProvider(() => "cli");

// Boot the interactive TUI: bring a local node online if none is answering (no-op
// if Core is already up or the target is remote), then mount the shell. This is the
// bare `ryu` / `ryu tui` path — unchanged from before the CLI dispatcher.
const bootInteractive = async (): Promise<void> => {
	const node = parseArgs(process.argv.slice(2)).flags.node;
	const target = buildInteractiveTarget(node);
	await ensureCoreRunning(target);
	// Identify the signed-in user to shared nodes before the first request.
	await installCliIdentity(target, { keepFresh: true });
	void startCliAutoUpdate(target).catch(() => undefined);
	void reportCliReferralEvent(target);
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		onDestroy: () => {
			if (herdrReporter) {
				void herdrReporter.release().finally(() => process.exit(0));
			} else {
				process.exit(0);
			}
		},
	});
	const quit = () => {
		// A signal quits too: hand the terminal its own title back first.
		renderer.setTerminalTitle("");
		if (herdrReporter) {
			void herdrReporter.release().finally(() => renderer.destroy());
		} else {
			renderer.destroy();
		}
	};
	process.once("SIGTERM", quit);
	process.once("SIGINT", quit);
	herdrReporter?.update(
		Symbol("shell"),
		{ focused: false, state: "idle" },
		target.url
	);
	createRoot(renderer).render(<App persistLayout target={target} />);
};

// argv dispatch (the gh/docker shape). A recognized subcommand runs non-interactively
// and exits with a code; no subcommand (or `tui`) opens the interactive shell. Unlike
// the interactive path, one-shot commands do NOT auto-spawn a local Core — they talk
// to whatever node is configured and fail with a clear error if it is unreachable.
const argv = process.argv.slice(2);

async function runOneShotWithAccessGate(): Promise<number> {
	const target = buildTarget();
	if (requiresWaitlistAccess(argv)) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		const access = await resolveCliWaitlistAccess(target, controller.signal);
		clearTimeout(timeout);
		if (access !== "approved") {
			const message =
				access === "unauthenticated"
					? "Sign in first with `ryu-cli login`."
					: access === "pending"
						? "Your account is still on the waitlist."
						: "Ryu could not verify waitlist access. Try again when the control plane is reachable.";
			process.stderr.write(`${message}\n`);
			return 1;
		}
	}
	return runCli(argv);
}

/** The node the background update worker reports against: `--node` resolved
 *  through the saved registry (a name is not a URL), else the env target. An
 *  unknown `--node` falls back here; the command itself reports the error. */
function updateWorkerTarget(nodeRef: string | null): ApiTarget {
	if (!nodeRef) {
		return buildTarget();
	}
	try {
		return resolveNodeTarget(nodeRef);
	} catch {
		return buildTarget();
	}
}

if (argv.length === 1 && argv[0] === "--internal-cli-update") {
	runCliAutoUpdate(buildTarget())
		.then(() => process.exit(0))
		.catch(() => process.exit(0));
} else if (isInteractive(argv)) {
	bootInteractive().catch((err) => {
		void herdrReporter?.release();
		process.stderr.write(`ryu-cli failed to start: ${String(err)}\n`);
		process.exitCode = 1;
	});
} else {
	startCliAutoUpdateWorker(updateWorkerTarget(parseArgs(argv).flags.node));
	// Keep the process alive until the best-effort event has had a chance to
	// leave the CLI, while the access-free auth/local commands remain available.
	installCliIdentity(buildTarget())
		.then(() => reportCliReferralEvent(buildTarget()))
		.then(() => runOneShotWithAccessGate())
		.then((code) => process.exit(code))
		.catch((err) => {
			process.stderr.write(`ryu: ${String(err)}\n`);
			process.exit(1);
		});
}
