/**
 * Server-side classification of which device surface a session belongs to.
 *
 * Pure functions only (no database, no Better Auth runtime), so the auth
 * plugin, the API's session routes, and tests share one rule set.
 *
 * Signals, strongest first:
 *
 * 1. The device-authorization `client_id` the grant was created for. Better
 *    Auth checks it against the allowlist and binds the device code to it.
 * 2. For `ryu-desktop`, which Desktop, the hosted web app build, and Core all
 *    use: a surface the client declared in its scope (`ryu:surface:desktop`,
 *    `ryu:surface:web`, or `ryu:surface:self_hosted`), then the request Origin.
 *    A Tauri webview origin is Desktop, any other browser origin is the hosted
 *    web app, and no Origin at all is a Core runtime (self-hosted, headless).
 *    A Core grant can be declared a mobile or CLI sign-in at approval time:
 *    the Ryu mobile app and the Ryu CLI sign in through a Core node and open
 *    the approval link with `surface=mobile` or `surface=cli`; the approving
 *    account owner's `/device/approve` request carries it and the grant's
 *    scope records `ryu:surface:<surface>` (see `approvalDeclaredSurface`).
 * 3. The Expo client's `expo-origin` header for direct mobile sign-ins.
 * 4. Anything else is a web browser sign-in.
 *
 * Every signal is provenance, not attestation: a client id and an Origin are
 * public. They only choose which bucket a session counts against; none of
 * them exempts a session from counting.
 */
import { TAURI_DESKTOP_ORIGINS } from "./cors-origins.ts";
import {
	approvalDeclarableSurface,
	DEVICE_SURFACE_FIELD,
	type DeviceSurface,
	declaredDeviceSurface,
	deviceSurfaceScopeToken,
	isDeviceSurface,
} from "./device-limits.ts";

/**
 * `ryu-client-session.ts`'s `ISSUED_CLIENT_ID_FIELD`, repeated so the session
 * plugin can import this module without an import cycle.
 */
const ISSUED_CLIENT_ID_FIELD = "issuedClientId";

/** Better Auth device-authorization client ids Ryu ships. */
export const DEVICE_CLIENT_SURFACES = {
	"ryu-cli": "cli",
	"ryu-extension": "extension",
	"ryu-mcp": "cli",
	"ryu-mobile": "mobile",
	"ryu-web": "web",
} as const satisfies Record<string, DeviceSurface>;

const DESKTOP_CLIENT_ID = "ryu-desktop";

/**
 * Surfaces a `ryu-desktop` grant's scope may declare: the Tauri build
 * (`desktop`), the hosted web app build of the same flow (`web`), Core
 * (`self_hosted`), and a mobile or CLI sign-in routed through a Core node
 * (`mobile`, `cli`, recorded at approval time).
 */
const DESKTOP_CLIENT_DECLARABLE: readonly DeviceSurface[] = [
	"desktop",
	"web",
	"self_hosted",
	"mobile",
	"cli",
];

export interface DeviceSurfaceSignals {
	/** Device-authorization client id, when the session comes from a grant. */
	clientId?: string | null;
	/** Surface declared in the grant's scope (`ryu:surface:<id>`). */
	declaredSurface?: DeviceSurface | null;
	/** The `expo-origin` header the Expo client sends. */
	expoOrigin?: string | null;
	/** The request `Origin` header. */
	origin?: string | null;
}

function isTauriOrigin(origin: string): boolean {
	return (TAURI_DESKTOP_ORIGINS as readonly string[]).includes(origin);
}

function isBrowserOrigin(origin: string): boolean {
	return origin.startsWith("https://") || origin.startsWith("http://");
}

function desktopClientSurface(signals: DeviceSurfaceSignals): DeviceSurface {
	const declared = signals.declaredSurface;
	if (declared && DESKTOP_CLIENT_DECLARABLE.includes(declared)) {
		return declared;
	}
	const origin = signals.origin?.trim() ?? "";
	if (origin.length === 0 || origin === "null") {
		return "self_hosted";
	}
	if (isTauriOrigin(origin)) {
		return "desktop";
	}
	return isBrowserOrigin(origin) ? "web" : "desktop";
}

/** Which surface a session being created from these signals belongs to. */
export function classifyDeviceSurface(
	signals: DeviceSurfaceSignals
): DeviceSurface {
	const clientId = signals.clientId ?? null;
	if (clientId === DESKTOP_CLIENT_ID) {
		return desktopClientSurface(signals);
	}
	if (clientId && Object.hasOwn(DEVICE_CLIENT_SURFACES, clientId)) {
		return DEVICE_CLIENT_SURFACES[
			clientId as keyof typeof DEVICE_CLIENT_SURFACES
		];
	}
	if (signals.expoOrigin && signals.expoOrigin.trim().length > 0) {
		return "mobile";
	}
	return "web";
}

/**
 * The surface an approval request declares for a grant, or null when the
 * declaration does not apply. It applies only to a `ryu-desktop` grant whose
 * scope declares nothing yet (a Core runtime), and only for a surface in
 * `APPROVAL_DECLARABLE_SURFACES` (`device-limits.ts`). Like every other signal it only chooses the
 * bucket; it never exempts a session from counting.
 */
export function approvalDeclaredSurface(
	clientId: string | null | undefined,
	scope: string | null | undefined,
	requested: unknown
): DeviceSurface | null {
	if (clientId !== DESKTOP_CLIENT_ID || declaredDeviceSurface(scope) !== null) {
		return null;
	}
	return approvalDeclarableSurface(requested);
}

/** `scope` with the token that declares `surface` appended. */
export function scopeDeclaringSurface(
	scope: string | null | undefined,
	surface: DeviceSurface
): string {
	const base = typeof scope === "string" ? scope.trim() : "";
	const token = deviceSurfaceScopeToken(surface);
	return base.length > 0 ? `${base} ${token}` : token;
}

/** The surface a device-authorization grant will be counted against. */
export function deviceGrantSurface(
	clientId: string | null | undefined,
	declaredSurface: DeviceSurface | null | undefined
): DeviceSurface {
	return classifyDeviceSurface({
		clientId: clientId ?? null,
		declaredSurface: declaredSurface ?? null,
		// No Origin is known at approval time; a grant that does not declare a
		// Desktop surface is treated as a Core runtime.
		origin: null,
	});
}

function readString(row: object, field: string): string | null {
	if (!(field in row)) {
		return null;
	}
	const value = (row as Record<string, unknown>)[field];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The surface of a stored session row. Rows stamped since device limits
 * shipped carry `surface`; older rows are classified from the issuance stamp
 * and user agent (a Core runtime sends no user agent).
 */
export function sessionDeviceSurface(row: unknown): DeviceSurface {
	if (typeof row !== "object" || row === null) {
		return "web";
	}
	const stored = readString(row, DEVICE_SURFACE_FIELD);
	if (isDeviceSurface(stored)) {
		return stored;
	}
	const clientId = readString(row, ISSUED_CLIENT_ID_FIELD);
	if (clientId === DESKTOP_CLIENT_ID) {
		return readString(row, "userAgent") === null ? "self_hosted" : "desktop";
	}
	return classifyDeviceSurface({ clientId });
}

/** True when a stored session row counts toward a device limit at `now`. */
export function sessionCountsTowardDeviceLimit(
	row: unknown,
	now: Date
): boolean {
	if (typeof row !== "object" || row === null) {
		return false;
	}
	if (readString(row, "impersonatedBy") !== null) {
		return false;
	}
	const expiresAt = (row as { expiresAt?: unknown }).expiresAt;
	const expiry =
		expiresAt instanceof Date
			? expiresAt.getTime()
			: typeof expiresAt === "string" || typeof expiresAt === "number"
				? new Date(expiresAt).getTime()
				: Number.NaN;
	return Number.isFinite(expiry) && expiry > now.getTime();
}

/** Live, non-impersonated sessions per surface. */
export function countSessionsBySurface(
	rows: Iterable<unknown>,
	now: Date
): Record<DeviceSurface, number> {
	const counts: Record<DeviceSurface, number> = {
		web: 0,
		desktop: 0,
		self_hosted: 0,
		mobile: 0,
		extension: 0,
		cli: 0,
	};
	for (const row of rows) {
		if (sessionCountsTowardDeviceLimit(row, now)) {
			counts[sessionDeviceSurface(row)] += 1;
		}
	}
	return counts;
}
