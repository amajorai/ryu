import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { telegramManagedBotFixture } from "./telegram-managed-bot-panel-proof.fixture.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "/",
	cacheDir: `${tmpdir()}/ryu-telegram-managed-bot-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["telegram-managed-bot-panel-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react(), telegramManagedBotFixture()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: { alias: { "@": desktopRoot } },
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5477, strictPort: true },
});
