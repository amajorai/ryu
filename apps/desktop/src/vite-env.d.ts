/// <reference types="vite/client" />

// Desktop Vite publishes these optional VITE_ values from dotenv/process.env
// as strings. The native ImportMetaEnv interface retains all Vite-owned fields.
interface ImportMetaEnv {
	readonly VITE_ANDROID_APP_URL?: string;
	readonly VITE_APP_VERSION?: string;
	readonly VITE_AUTH_CORE_URL?: string;
	readonly VITE_CORE_URL?: string;
	readonly VITE_IOS_APP_URL?: string;
	/** "1" only in the Codespaces playground webapp build (`lib/playground.ts`). */
	readonly VITE_PLAYGROUND?: string;
	readonly VITE_POSTHOG_HOST?: string;
	readonly VITE_POSTHOG_KEY?: string;
	readonly VITE_SENTRY_DSN?: string;
}
