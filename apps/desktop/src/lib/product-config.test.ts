import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// This is the complete native-window and product projection asserted below,
// rather than an unchecked claim that arbitrary JSON is a full Tauri config.
const productWindowSchema = z.object({
	additionalBrowserArgs: z.string(),
	center: z.boolean(),
	decorations: z.boolean(),
	dragDropEnabled: z.boolean(),
	height: z.number(),
	minHeight: z.number(),
	minWidth: z.number(),
	resizable: z.boolean(),
	shadow: z.boolean(),
	title: z.string(),
	transparent: z.boolean(),
	width: z.number(),
	zoomHotkeysEnabled: z.boolean(),
});
type ProductWindowRegression = z.output<typeof productWindowSchema>;
const productConfigRegressionSchema = z.object({
	app: z.object({
		windows: z.tuple([productWindowSchema]).rest(productWindowSchema),
	}),
	identifier: z.string(),
	mainBinaryName: z.string(),
	productName: z.string(),
	plugins: z.object({
		updater: z.object({ endpoints: z.array(z.string()), pubkey: z.string() }),
	}),
});
const desktopRoot = join(import.meta.dir, "../..");
function readProductConfig(path: string) {
	return productConfigRegressionSchema.parse(
		JSON.parse(readFileSync(join(desktopRoot, path), "utf8"))
	);
}

describe("Ryu Bot desktop product config", () => {
	test("keeps the shared native window settings while changing product identity", () => {
		const buildWindow = readProductConfig("src-tauri/tauri.conf.json").app
			.windows[0];
		const botConfig = readProductConfig("src-tauri/tauri.bot.conf.json");
		const botWindow = botConfig.app.windows[0];
		const sharedWindowKeys = [
			"width",
			"height",
			"minWidth",
			"minHeight",
			"center",
			"resizable",
			"decorations",
			"transparent",
			"shadow",
			"dragDropEnabled",
			"zoomHotkeysEnabled",
			"additionalBrowserArgs",
		] satisfies (keyof ProductWindowRegression)[];

		for (const key of sharedWindowKeys) {
			expect(botWindow[key]).toBe(buildWindow[key]);
		}
		expect(botWindow.title).toBe("Ryu Bot");
		expect(botConfig.productName).toBe("Ryu Bot");
		expect(botConfig.mainBinaryName).toBe("Ryu Bot");
		expect(botConfig.identifier).toBe("ai.amajor.ryu.bot");
		const updater = botConfig.plugins.updater;
		expect(updater.endpoints).toEqual([
			"https://github.com/amajorai/ryu/releases/latest/download/latest-bot.json",
		]);
		expect(updater.pubkey).toEqual(expect.any(String));
	});
});
