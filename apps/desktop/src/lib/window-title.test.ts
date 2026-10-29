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
		).toBe("Ryu · Bot");
		expect(
			resolveDesktopWindowTitle({
				channel: "stable",
				dev: false,
				mode: "console",
				standaloneApp: false,
				standaloneAppName: "",
			})
		).toBe("Ryu · Agent");
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
		).toBe("Ryu · Agent Canary");
		expect(
			resolveDesktopWindowTitle({
				channel: "stable",
				dev: true,
				mode: "bot",
				standaloneApp: false,
				standaloneAppName: "",
			})
		).toBe("Ryu · Bot Dev");
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

	test("names the active workspace interface in the workspace mode", () => {
		const base = {
			channel: "stable",
			dev: false,
			standaloneApp: false,
			standaloneAppName: "",
		} as const;
		expect(resolveDesktopWindowTitle({ ...base, mode: "os" })).toBe("Ryu · OS");
		expect(
			resolveDesktopWindowTitle({ ...base, interfaceLabel: "OS", mode: "os" })
		).toBe("Ryu · OS");
		expect(
			resolveDesktopWindowTitle({
				...base,
				interfaceLabel: "Channels",
				mode: "os",
			})
		).toBe("Ryu · Channels");
		expect(
			resolveDesktopWindowTitle({
				...base,
				channel: "canary",
				interfaceLabel: "World 3D",
				mode: "os",
			})
		).toBe("Ryu · World 3D Canary");
		expect(
			resolveDesktopWindowTitle({ ...base, interfaceLabel: "  ", mode: "os" })
		).toBe("Ryu · OS");
	});

	test("keeps Bot and Console names when an interface label is present", () => {
		const base = {
			channel: "stable",
			dev: false,
			interfaceLabel: "Channels",
			standaloneApp: false,
			standaloneAppName: "",
		} as const;
		expect(resolveDesktopWindowTitle({ ...base, mode: "bot" })).toBe(
			"Ryu · Bot"
		);
		expect(resolveDesktopWindowTitle({ ...base, mode: "console" })).toBe(
			"Ryu · Agent"
		);
	});
});
