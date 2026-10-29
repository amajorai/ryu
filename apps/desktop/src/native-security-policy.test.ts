import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DESKTOP_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);

function readJson<Schema extends z.ZodType>(
	relativePath: string,
	schema: Schema
): z.output<Schema> {
	return schema.parse(
		JSON.parse(readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8"))
	);
}
const tauriConfigSchema = z.object({
	app: z.object({
		security: z.object({ csp: z.string() }),
		windows: z.array(
			z.object({ additionalBrowserArgs: z.string().optional() })
		),
		withGlobalTauri: z.boolean(),
	}),
});
const capabilitySchema = z.object({ permissions: z.array(z.string()) });

describe("native Desktop security policy", () => {
	test("keeps remote code and production media bypasses out of the main webview", () => {
		const config = readJson("src-tauri/tauri.conf.json", tauriConfigSchema);
		const browserArgs = config.app.windows[0]?.additionalBrowserArgs ?? "";

		expect(config.app.withGlobalTauri).toBe(false);
		expect(config.app.security.csp).not.toContain("cdn.userjot.com");
		expect(browserArgs).not.toContain("use-fake-ui-for-media-stream");
		expect(browserArgs).not.toContain("msSmartScreenProtection");
	});

	test("allows every fixed LAN profile over HTTP and realtime WebSocket", () => {
		const config = readJson("src-tauri/tauri.conf.json", tauriConfigSchema);
		for (const port of [7980, 8980, 9980, 10_980, 11_980]) {
			expect(config.app.security.csp).toContain(`http://*:${port}`);
			expect(config.app.security.csp).toContain(`ws://*:${port}`);
		}
	});

	test("exposes only the gated updater and keeps native windows operable", () => {
		const main = readJson(
			"src-tauri/capabilities/default.json",
			capabilitySchema
		);
		const tabs = readJson(
			"src-tauri/capabilities/tab-windows.json",
			capabilitySchema
		);

		expect(main.permissions).not.toContain("updater:default");
		expect(main.permissions).toContain("core:window:allow-set-title");
		for (const permission of [
			"core:event:default",
			"decorum:allow-show-snap-overlay",
			"core:window:allow-close",
			"core:window:allow-minimize",
			"core:window:allow-maximize",
			"core:window:allow-start-dragging",
			"core:window:allow-set-title",
		]) {
			expect(tabs.permissions).toContain(permission);
		}
	});
});
