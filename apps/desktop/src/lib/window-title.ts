import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import type { ProductMode } from "./product-mode.ts";
import type { ReleaseChannel } from "./release-channel.ts";

interface DesktopWindowTitleOptions {
	channel: ReleaseChannel;
	dev: boolean;
	/**
	 * Label of the active workspace interface, already in the reader's
	 * language ({@link windowInterfaceLabel}). Only consulted in the workspace
	 * ("os") mode; Bot and Agent keep their fixed product names.
	 */
	interfaceLabel?: string;
	mode: ProductMode;
	standaloneApp: boolean;
	standaloneAppName: string;
	/**
	 * The reactive `tl` from `useLiteralMessages()`, so the native title follows
	 * a language change (the DOM localizer never sees an OS window title).
	 */
	tl: LiteralMessage;
}

/** Product names that stay English in every language (brand names). */
const BRAND_RENDERERS = new Set(["bot", "console", "os"]);

/**
 * The active interface's label in the reader's language. Built-in labels
 * ("Channels", "Inbox") are English catalog sources; Bot, Agent and OS are
 * brand names and stay English. A Marketplace interface's label arrives
 * already localized from its manifest, so it is used as is.
 */
export function windowInterfaceLabel(
	descriptor: Pick<InterfaceDescriptor, "label" | "origin" | "renderer">,
	tl: LiteralMessage
): string {
	const label = descriptor.label.trim();
	if (
		!label ||
		descriptor.origin !== "builtin" ||
		BRAND_RENDERERS.has(descriptor.renderer)
	) {
		return label;
	}
	return tl(label);
}

function releaseSuffix(
	dev: boolean,
	channel: ReleaseChannel,
	tl: LiteralMessage
): string | undefined {
	if (dev) {
		return tl("Dev");
	}
	switch (channel) {
		case "canary":
			return tl("Canary");
		case "nightly":
			return tl("Nightly");
		case "beta":
			return tl("Beta");
		default:
			return undefined;
	}
}

function productLabel(mode: ProductMode, interfaceLabel?: string): string {
	if (mode === "bot") {
		return "Bot";
	}
	if (mode === "console") {
		return "Agent";
	}
	return interfaceLabel?.trim() || "OS";
}

/** Resolve the title shown by the native window and the OS task switcher. */
export function resolveDesktopWindowTitle({
	channel,
	dev,
	interfaceLabel,
	mode,
	standaloneApp,
	standaloneAppName,
	tl,
}: DesktopWindowTitleOptions): string {
	if (standaloneApp) {
		return standaloneAppName || "Ryu App";
	}

	// "Ryu · Agent", not "Ryu Agent": that is the default agent's name.
	const productTitle = tl("Ryu · {product}", {
		product: productLabel(mode, interfaceLabel),
	});
	const suffix = releaseSuffix(dev, channel, tl);
	return suffix ? `${productTitle} ${suffix}` : productTitle;
}
