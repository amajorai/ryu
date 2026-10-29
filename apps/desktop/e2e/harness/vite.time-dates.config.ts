import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { installedIndividualIcons } from "./installed-individual-icons.ts";

const desktop = path.resolve(import.meta.dirname, "../..");
const story = process.env.RYU_TIME_DATES_STORY ?? "timezone-picker-story.html";
const cacheDir = process.env.RYU_TIME_DATES_VITE_CACHE;
if (!(cacheDir && path.isAbsolute(cacheDir))) {
	throw new Error("An absolute owned time/date Vite cache is required");
}
export default defineConfig({
	root: import.meta.dirname,
	cacheDir,
	publicDir: path.join(desktop, "public"),
	plugins: [installedIndividualIcons(), react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: [story],
		exclude: [
			"@hugeicons/core-free-icons",
			"@tabler/icons-react",
			"lucide-react",
		],
		esbuildOptions: { target: "esnext" },
	},
	resolve: { dedupe: ["react", "react-dom"], alias: { "@": desktop } },
	build: {
		outDir: path.join(cacheDir, "build"),
		target: "chrome105",
		emptyOutDir: true,
		// Gzip size reporting is console-only and holds every chunk twice.
		reportCompressedSize: false,
		rollupOptions: {
			input: path.resolve(import.meta.dirname, story),
			// Ownership audits read only `sources` and `mappings`. Omitting embedded
			// source text keeps the full Sidebar graph's maps within proof memory.
			output: {
				sourcemapExcludeSources:
					process.env.RYU_TIME_DATES_MAP_SOURCES === "exclude",
			},
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5183"),
		strictPort: true,
		// A proof run serves one source snapshot: unrelated edits in a shared
		// working tree must not hot-reload a page mid-assertion.
		hmr: false,
		watch: null,
	},
});
