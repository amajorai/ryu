/**
 * The `/device/token` -> session-hook hand-off for device limits.
 *
 * `/device/token`'s pre-check classifies an approved grant from its scope,
 * which is gone once Better Auth consumes the device code. It remembers the
 * surface here, keyed by the device code, and the session-create hook in the
 * same request takes it back. In-process, short-lived, and read once.
 */
import type { DeviceSurface } from "./device-limits.ts";

const GRANT_SURFACE_TTL_MS = 120_000;
const GRANT_SURFACE_PRUNE_SIZE = 1000;
const grantSurfaces = new Map<
	string,
	{ expiresAt: number; surface: DeviceSurface }
>();

/** Remember the surface `/device/token` computed for `deviceCode`. */
export function rememberGrantSurface(
	deviceCode: string,
	surface: DeviceSurface,
	now: number = Date.now()
): void {
	if (grantSurfaces.size >= GRANT_SURFACE_PRUNE_SIZE) {
		for (const [key, entry] of grantSurfaces) {
			if (entry.expiresAt <= now) {
				grantSurfaces.delete(key);
			}
		}
		if (grantSurfaces.size >= GRANT_SURFACE_PRUNE_SIZE) {
			const oldest = grantSurfaces.keys().next();
			if (!oldest.done) {
				grantSurfaces.delete(oldest.value);
			}
		}
	}
	grantSurfaces.set(deviceCode, {
		expiresAt: now + GRANT_SURFACE_TTL_MS,
		surface,
	});
}

/** Read and forget the remembered surface for `deviceCode`. */
export function takeGrantSurface(
	deviceCode: string,
	now: number = Date.now()
): DeviceSurface | null {
	const entry = grantSurfaces.get(deviceCode);
	grantSurfaces.delete(deviceCode);
	return entry && entry.expiresAt > now ? entry.surface : null;
}
