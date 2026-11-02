import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import {
	resolveDesktopWindowTitle as resolveTitle,
	windowInterfaceLabel,
} from "./window-title.ts";

/** A stub translator over one catalog that fills `{name}` placeholders. */
function translator(catalog: Record<string, string>): LiteralMessage {
	return (source, values) =>
		(catalog[source] ?? source).replace(/\{(\w+)\}/g, (_, key: string) =>
			String((values as Record<string, unknown> | undefined)?.[key] ?? "")
		);
}

const en = translator({});
const de = translator({
	Beta: "Beta",
	Channels: "Kanäle",
	Nightly: "Nightly-Build",
	"Ryu · {product}": "Ryu · {product}",
});

/** The English title, as every case below was written before `tl` existed. */
function resolveDesktopWindowTitle(
	options: Omit<Parameters<typeof resolveTitle>[0], "tl">
): string {
	return resolveTitle({ ...options, tl: en });
}

function descriptor(
	renderer: InterfaceDescriptor["renderer"],
	label: string,
	origin: InterfaceDescriptor["origin"] = "builtin"
): Pick<InterfaceDescriptor, "label" | "origin" | "renderer"> {
	return { label, origin, renderer };
}

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

	test("translates built-in interface labels and the channel, not brand names", () => {
		const base = {
			channel: "stable",
			dev: false,
			mode: "os",
			standaloneApp: false,
			standaloneAppName: "",
		} as const;
		const channels = descriptor("channels", "Channels");
		expect(
			resolveTitle({
				...base,
				interfaceLabel: windowInterfaceLabel(channels, de),
				tl: de,
			})
		).toBe("Ryu · Kanäle");
		expect(
			resolveTitle({
				...base,
				channel: "nightly",
				interfaceLabel: windowInterfaceLabel(channels, de),
				tl: de,
			})
		).toBe("Ryu · Kanäle Nightly-Build");
		// Bot, Agent and OS are brand names and stay English.
		const brandOnly = translator({
			Agent: "Agent-DE",
			Bot: "Bot-DE",
			OS: "BS",
		});
		expect(windowInterfaceLabel(descriptor("os", "OS"), brandOnly)).toBe("OS");
		expect(resolveTitle({ ...base, mode: "bot", tl: brandOnly })).toBe(
			"Ryu · Bot"
		);
		// A Marketplace label arrives localized from its manifest: used as is.
		expect(
			windowInterfaceLabel(
				descriptor("channels", "Channels", "marketplace"),
				de
			)
		).toBe("Channels");
	});

	test("recomputes in the new language when the locale switches", () => {
		const options = {
			channel: "stable",
			dev: false,
			mode: "os",
			standaloneApp: false,
			standaloneAppName: "",
		} as const;
		const channels = descriptor("channels", "Channels");
		const titleIn = (tl: LiteralMessage) =>
			resolveTitle({
				...options,
				interfaceLabel: windowInterfaceLabel(channels, tl),
				tl,
			});
		expect(titleIn(en)).toBe("Ryu · Channels");
		expect(titleIn(de)).toBe("Ryu · Kanäle");
		expect(titleIn(en)).toBe("Ryu · Channels");
	});
});
