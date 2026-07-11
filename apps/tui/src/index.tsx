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
import { App } from "./App.tsx";
import { buildTarget } from "./core/target.ts";

const main = async (): Promise<void> => {
	const renderer = await createCliRenderer({ exitOnCtrlC: false });
	createRoot(renderer).render(<App target={buildTarget()} />);
};

main().catch((err) => {
	process.stderr.write(`ryu-tui failed to start: ${String(err)}\n`);
	process.exitCode = 1;
});
