import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import { selectedDesktopBrowserStaticSuite } from "../desktop-browser-static-suites.ts";
import controls from "./vite.chat-page-control-paths.config.ts";
import transcript from "./vite.chat-performance-proof.config.ts";
import sidebar from "./vite.chat-sidebar-suite.config.ts";
import keyboardAuthority from "./vite.keyboard-shortcuts-authority-proof.config.ts";
import keyboard from "./vite.keyboard-shortcuts-proof.config.ts";
import scrollableTabs from "./vite.scrollable-tabs-host-proof.config.ts";
import dock from "./vite.workspace-dock-proof.config.ts";

const suite = selectedDesktopBrowserStaticSuite();
const canonical = {
	controls,
	dock,
	keyboard,
	"keyboard-authority": keyboardAuthority,
	"scrollable-tabs": scrollableTabs,
	sidebar,
	transcript,
};

// Preserve each installed production dependency/CSS graph. Explicit HTML input
// closes all pages referenced by that canonical suite, including transcript
// grouping/search pages absent from its original single-page build input.
export default mergeConfig(
	canonical[suite.name as keyof typeof canonical],
	defineConfig({
		build: {
			outDir: path.resolve(
				process.env.RYU_DESKTOP_BROWSER_DIST ??
					path.join(tmpdir(), `ryu-desktop-${suite.name}-static`)
			),
			emptyOutDir: true,
			rollupOptions: {
				input: Object.fromEntries(
					suite.html.map((html) => [
						html.replace(/\.html$/, ""),
						path.join(import.meta.dirname, html),
					])
				),
			},
		},
	})
);
