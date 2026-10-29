import type { ProductMode } from "./product-mode.ts";
import type { ReleaseChannel } from "./release-channel.ts";

interface DesktopWindowTitleOptions {
	channel: ReleaseChannel;
	dev: boolean;
	/**
	 * Label of the active workspace interface ("Channels", a Marketplace
	 * interface's name). Only consulted in the workspace ("os") mode; Bot and
	 * Agent keep their fixed product names.
	 */
	interfaceLabel?: string;
	mode: ProductMode;
	standaloneApp: boolean;
	standaloneAppName: string;
}

function releaseSuffix(
	dev: boolean,
	channel: ReleaseChannel
): string | undefined {
	if (dev) {
		return "Dev";
	}
	if (channel === "stable") {
		return undefined;
	}
	return channel.charAt(0).toUpperCase() + channel.slice(1);
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
}: DesktopWindowTitleOptions): string {
	if (standaloneApp) {
		return standaloneAppName || "Ryu App";
	}

	// "Ryu · Agent", not "Ryu Agent": that is the default agent's name.
	const productTitle = `Ryu · ${productLabel(mode, interfaceLabel)}`;
	const suffix = releaseSuffix(dev, channel);
	return suffix ? `${productTitle} ${suffix}` : productTitle;
}
