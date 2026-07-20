/** API origin — vite.config.ts injects prod vs dev values at build/dev time. */
export const BACKEND_URL =
	import.meta.env.VITE_APP_BACKEND_URL ?? "http://localhost:3000";

/** Marketing web origin (device-auth verification links). */
export const FRONTEND_URL =
	import.meta.env.VITE_APP_FRONTEND_URL ?? "http://localhost:3001";

/** In-app links to the web dashboard (gateway, connections, onboarding). */
export const WEB_URL =
	import.meta.env.VITE_APP_WEB_URL ?? "http://localhost:3001";
