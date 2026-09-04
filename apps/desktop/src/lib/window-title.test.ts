import { describe, expect, test } from "bun:test";
import { resolveDesktopWindowTitle } from "./window-title.ts";

describe("desktop window title", () => {
	test("uses the active product mode", () => {
		expect(
			resolveDesktopWindowTitle({
				channel: "stable",
				dev: false,
				mode: "bot",
				standaloneApp: false,
				standaloneAppName: "",
			})
		).toBe("Ryu Bot");
		expect(
			resolveDesktopWindowTitle({
				channel: "stable",
				dev: false,
				mode: "console",
				standaloneApp: false,
				standaloneAppName: "",
			})
		).toBe("Ryu Console");
	});

	test("adds a channel suffix without calling the product a preview", () => {
		expect(
			resolveDesktopWindowTitle({
				channel: "canary",
				dev: false,
				mode: "console",
				standaloneApp: false,
				standaloneAppName: "",
			})
		).toBe("Ryu Console Canary");
		expect(
			resolveDesktopWindowTitle({
				channel: "stable",
				dev: true,
				mode: "bot",
				standaloneApp: false,
				standaloneAppName: "",
			})
		).toBe("Ryu Bot Dev");
	});

	test("keeps standalone app names independent of product mode", () => {
		expect(
			resolveDesktopWindowTitle({
				channel: "nightly",
				dev: true,
				mode: "console",
				standaloneApp: true,
				standaloneAppName: "Ryu Checks",
			})
		).toBe("Ryu Checks");
		expect(
			resolveDesktopWindowTitle({
				channel: "stable",
				dev: false,
				mode: "bot",
				standaloneApp: true,
				standaloneAppName: "",
			})
		).toBe("Ryu App");
	});
});
