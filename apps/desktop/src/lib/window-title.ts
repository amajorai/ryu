import type { ProductMode } from "./product-mode.ts";
import type { ReleaseChannel } from "./release-channel.ts";

interface DesktopWindowTitleOptions {
	channel: ReleaseChannel;
	dev: boolean;
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

/** Resolve the title shown by the native window and the OS task switcher. */
export function resolveDesktopWindowTitle({
	channel,
	dev,
	mode,
	standaloneApp,
	standaloneAppName,
}: DesktopWindowTitleOptions): string {
	if (standaloneApp) {
		return standaloneAppName || "Ryu App";
	}

	const productTitle =
		mode === "bot" ? "Ryu Bot" : mode === "os" ? "Ryu OS" : "Ryu Console";
	const suffix = releaseSuffix(dev, channel);
	return suffix ? `${productTitle} ${suffix}` : productTitle;
}
