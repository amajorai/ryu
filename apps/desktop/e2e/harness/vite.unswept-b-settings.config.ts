import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Serves the unswept-b settings story, the unchanged settings-dialog shell
// story and the unchanged startup-performance story on one port of their own,
// with the Vite cache outside the checkout.
const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

// Mutation and baseline runs only: serve scratch bodies (under /tmp) at
// shipping module paths, so a mutant or the previous code is exercised without
// editing the shipping files. One pair comes from
// RYU_UNSWEPT_B_OVERRIDE_TARGET/RYU_UNSWEPT_B_OVERRIDE_FILE; more come from
// RYU_UNSWEPT_B_OVERRIDES as `target=file` pairs separated by `;`.
function scratchOverrides(): Map<string, string> {
	const overrides = new Map<string, string>();
	const target = process.env.RYU_UNSWEPT_B_OVERRIDE_TARGET;
	const file = process.env.RYU_UNSWEPT_B_OVERRIDE_FILE;
	if (target && file) {
		overrides.set(target, file);
	}
	for (const pair of (process.env.RYU_UNSWEPT_B_OVERRIDES ?? "").split(";")) {
		const [pairTarget, pairFile] = pair.split("=");
		if (pairTarget && pairFile) {
			overrides.set(pairTarget, pairFile);
		}
	}
	return overrides;
}

function scratchOverride(): Plugin | null {
	const overrides = scratchOverrides();
	if (overrides.size === 0) {
		return null;
	}
	return {
		enforce: "pre",
		load(id) {
			const file = overrides.get(id.split("?")[0] ?? id);
			return file ? readFileSync(file, "utf8") : null;
		},
		name: "unswept-b-scratch-override",
	};
}

export default defineConfig({
	plugins: [scratchOverride(), react()],
	base: "./",
	cacheDir: process.env.RYU_UNSWEPT_B_VITE_CACHE ?? "/tmp/unswept-b-pw/vite",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		include: ["lucide-react"],
		entries: [
			"unswept-b-settings.html",
			"settings-dialog-shell-proof.html",
			"startup-performance-proof.html",
		],
	},
	resolve: {
		alias: { "@": desktopRoot },
	},
	server: {
		host: "127.0.0.1",
		port: 5293,
		strictPort: true,
		watch: null,
	},
});
