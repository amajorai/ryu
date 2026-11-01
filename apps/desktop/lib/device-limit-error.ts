import {
	type DeviceSurface,
	deviceLimitReachedMessage,
	deviceSurfaceScopeToken,
	parseDeviceLimitRefusal,
} from "@ryu/auth/lib/device-limits";

// Device-limit refusals for the browser-side device-flow pollers. Desktop and
// the extension share this module (the extension resolves `@/lib/*` to the
// desktop tree), so both explain a refusal with the same sentence. Clients only
// explain a refusal; the auth server decides it.

/** Shown when the refusal body names neither the surface nor its cap. */
export const DEVICE_LIMIT_GENERIC_MESSAGE =
	"Device limit reached: this account is already signed in on as many devices of this kind as it allows. Sign out of one you no longer use, then try again.";

/**
 * The sign-in error sentence for a device-limit refusal, or null when `body`
 * is not one. Accepts a device-token JSON body or a bare RFC 8628 `error`.
 */
export function deviceLimitSignInMessage(body: unknown): string | null {
	const refusal = parseDeviceLimitRefusal(body);
	if (!refusal) {
		return null;
	}
	if (refusal.surface && refusal.limit !== null) {
		return deviceLimitReachedMessage(refusal.surface, refusal.limit);
	}
	return DEVICE_LIMIT_GENERIC_MESSAGE;
}

/**
 * Error thrown (extension) or passed to `onError` (desktop) when the server
 * refuses a sign-in because the surface is at its cap. Typed so a caller can
 * tell it apart from a timeout. `message` is the English sentence; `surface`
 * and `limit` (null when the refusal did not name both) let a UI localize it.
 */
export class DeviceLimitReachedError extends Error {
	readonly limit: number | null;
	readonly surface: DeviceSurface | null;

	constructor(body: unknown) {
		super(deviceLimitSignInMessage(body) ?? DEVICE_LIMIT_GENERIC_MESSAGE);
		this.name = "DeviceLimitReachedError";
		const refusal = parseDeviceLimitRefusal(body);
		const complete = refusal?.surface && refusal.limit !== null;
		this.surface = complete ? refusal.surface : null;
		this.limit = complete ? refusal.limit : null;
	}
}

/**
 * The device-code `scope` for a Ryu client. Desktop, the hosted webapp, and
 * Core share the `ryu-desktop` client id, so the Tauri app declares `desktop`
 * and the hosted webapp declares `web`; the extension dashboard (same module,
 * no Tauri bridge) passes null and is classified by the server.
 */
export function deviceCodeScope(
	baseScope: string,
	surface: DeviceSurface | null
): string {
	return surface
		? `${baseScope} ${deviceSurfaceScopeToken(surface)}`
		: baseScope;
}
