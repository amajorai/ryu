#!/usr/bin/env bun
/* @jsxImportSource @opentui/react */
// Entry point for the Ryu TUI. Boots the OpenTUI renderer and mounts <App/>.
//
// We disable exitOnCtrlC so the shell can route Ctrl+C through renderer.destroy()
// (the only correct way to quit - process.exit() leaves the terminal in raw mode
// with the alternate screen still active). The active Core node is resolved once
// from the environment (RYU_CORE_URL / RYU_CORE_TOKEN) and handed to the provider.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { setSurfaceProvider } from "@ryuhq/core-client/client";
import { App } from "./App.tsx";
import { ensureCoreRunning } from "./core/bootstrap.ts";
import { buildTarget } from "./core/target.ts";

// Declare the calling surface once, at entry, so EVERY core-client request carries
// `X-Ryu-Surface: cli` (makeHeaders reads the provider). Core filters the plugin
// list/catalog/contributions to what actually targets this surface; without it the
// list is unfiltered. The TUI is a terminal client to a Core node, so "cli" is the
// natural token (it shares that surface vocabulary with apps/cli). Mirrors the
// setBuyerTokenProvider precedent — the shared client never hardcodes a surface.
setSurfaceProvider(() => "cli");

const main = async (): Promise<void> => {
	const target = buildTarget();
	// Bring a local node online if none is answering (no-op if Core is already up or
	// the target is remote). Lets `ryu-tui` alone start everything, like the desktop.
	await ensureCoreRunning(target);
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	createRoot(renderer).render(<App target={target} />);
};

main().catch((err) => {
	process.stderr.write(`ryu-tui failed to start: ${String(err)}\n`);
	process.exitCode = 1;
});
