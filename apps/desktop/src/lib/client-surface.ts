/**
 * How this build of the shell identifies itself to Core (`X-Ryu-Client-Label`
 * and `X-Ryu-Surface`). Core filters plugin listings and contributions by the
 * surface, so it must name the host actually running the shell. The browser
 * extension replaces this module at bundle time (`desktopSeamReplacements` in
 * `apps/extension/wxt.config.ts`).
 */
export const CLIENT_SURFACE = {
	label: "Desktop",
	surface: "desktop",
} as const;
