import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

let exchanges = 0;
const api: Plugin = {
	name: "telegram-session-proof-fixture",
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			if (request.url === "/__telegram-proof/status") {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ exchanges }));
				return;
			}
			if (request.url === "/api/auth/telegram-mini-app/session") {
				exchanges += 1;
				response.setHeader("Content-Type", "application/json");
				response.end(
					JSON.stringify({ token: "fixture-session", telegram_user_id: "42" })
				);
				return;
			}
			next();
		});
	},
};
const seams = path.resolve(
	import.meta.dirname,
	"telegram-session-proof-seams.ts"
);
export default defineConfig({
	root: import.meta.dirname,
	plugins: [api, react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: [path.resolve(import.meta.dirname, "telegram-session-proof.html")],
	},
	resolve: {
		alias: [
			{ find: "@/lib/auth-client.ts", replacement: seams },
			{ find: "@/lib/app-urls.ts", replacement: seams },
		],
	},
	server: { host: "127.0.0.1", port: 5362, strictPort: true },
});
