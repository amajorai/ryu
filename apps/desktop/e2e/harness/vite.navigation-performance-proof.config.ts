import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: {
			...(process.env.RYU_NAV_BASELINE
				? {
						"@/src/contexts/TitleBarContext.tsx":
							"/tmp/ryu-navigation-baseline/TitleBarContext.tsx",
						"@/src/contexts/TabsContext.tsx":
							"/tmp/ryu-navigation-baseline/TabsContext.tsx",
						"@/src/contributions/RouteOutlet.tsx":
							"/tmp/ryu-navigation-baseline/RouteOutlet.tsx",
					}
				: undefined),
			"@": desktopRoot,
		},
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
		fs: {
			allow: [
				path.resolve(desktopRoot, "../.."),
				"/tmp/ryu-navigation-baseline",
			],
		},
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-navigation-performance-proof"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "navigation-performance-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
