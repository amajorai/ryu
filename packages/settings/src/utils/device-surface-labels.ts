import type { DeviceSurface } from "@ryu/auth/lib/device-limits";
import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * Localized surface names. Each label is a literal `tl()` call so the
 * extractor sees it; the English text matches `DEVICE_SURFACE_LABELS` in
 * `@ryu/auth/lib/device-limits`.
 */
export function localizedDeviceSurfaceLabel(
	tl: LiteralMessage,
	surface: DeviceSurface
): string {
	switch (surface) {
		case "web":
			return tl("Web browsers");
		case "desktop":
			return tl("Ryu Desktop");
		case "self_hosted":
			return tl("Self-hosted and headless Core");
		case "mobile":
			return tl("Mobile apps");
		case "extension":
			return tl("Browser extension");
		case "cli":
			return tl("CLI and MCP");
		default:
			return surface;
	}
}
