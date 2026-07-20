/**
 * Tauri v2 desktop webview origins (platform-specific). Production builds are NOT
 * localhost — Windows/Android use http://tauri.localhost; macOS/Linux use
 * tauri://localhost. Both must be CORS/trusted-origins allowed or every
 * control-plane fetch from a release build fails (waitlist gate, profile, etc.).
 */
export const TAURI_DESKTOP_ORIGINS = [
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
] as const;
