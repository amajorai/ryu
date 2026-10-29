import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-onboarding-setup-page-vite-cache`,
	optimizeDeps: {
		entries: ["onboarding-remaining-page-proof.html"],
		force: false,

		esbuildOptions: { target: "esnext" },
	},
	server: { hmr: false },
	build: {
		emptyOutDir: true,
		outDir: path.resolve(
			harnessDir,
			"../../../../tmp/ryu-onboarding-remaining-page-proof"
		),
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "onboarding-remaining-page-proof.html"),
		},
	},
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_FRONTEND_URL": JSON.stringify(
			"https://onboarding.fixture.invalid"
		),
	},
	plugins: [react()],
	publicDir: path.resolve(harnessDir, "../../public"),
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	root: harnessDir,
});
