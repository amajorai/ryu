import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const webSrc = path.resolve(harnessDir, "../../../web/src");

export default defineConfig({
	build: {
		emptyOutDir: true,
		outDir: path.resolve(harnessDir, "dist-org-seat-members-proof"),
		rollupOptions: {
			input: path.resolve(harnessDir, "org-seat-members-proof.html"),
		},
	},
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	plugins: [react()],
	resolve: {
		alias: [
			{
				find: "@/components/step-up-dialog.tsx",
				replacement: path.resolve(harnessDir, "stubs/org-seat-step-up.ts"),
			},
			{
				find: "@/lib/auth-client.ts",
				replacement: path.resolve(harnessDir, "stubs/org-seat-auth-client.ts"),
			},
			{
				find: "@/lib/http-error.ts",
				replacement: path.resolve(harnessDir, "stubs/org-seat-http-error.ts"),
			},
			{
				find: "@/lib/teams-billing.ts",
				replacement: path.resolve(
					harnessDir,
					"stubs/org-seat-teams-billing.ts"
				),
			},
			{
				find: "@ryu/env/web",
				replacement: path.resolve(harnessDir, "stubs/org-seat-env.ts"),
			},
			{
				find: "next/link",
				replacement: path.resolve(harnessDir, "stubs/org-seat-next-link.tsx"),
			},
			{
				find: "next/navigation",
				replacement: path.resolve(
					harnessDir,
					"stubs/org-seat-next-navigation.ts"
				),
			},
			{ find: "@", replacement: webSrc },
		],
	},
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: 5199,
		strictPort: true,
	},
});
