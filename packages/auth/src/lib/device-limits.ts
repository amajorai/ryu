/**
 * Device limits: how many signed-in devices one account may hold per surface.
 *
 * This file is the browser-safe contract shared by the auth server, the API,
 * and every Ryu client. It holds no database, Better Auth server, or host UI
 * imports, so the web, desktop, extension, CLI, and native apps can import the
 * same names and cannot drift.
 *
 * What counts:
 *
 * - One live Better Auth `session` row is one signed-in device. Each session is
 *   stamped server-side with the surface it was issued to (`surface`), and caps
 *   apply per surface, so ten browsers never block a desktop sign-in.
 * - Sessions that are expired, impersonated (support access, admin
 *   impersonation), or belong to an anonymous guest never count.
 * - Platform-managed compute (Ryu Cloud nodes, Boxes, managed bots, managed
 *   agents, Fleet-enrolled nodes) authenticates with server-minted node
 *   credentials, never with a user session, so it never counts no matter how
 *   many nodes an account runs.
 *
 * Enforcement is owned by the auth server and gated by the
 * `auth.device_limits` rollout flag (default off). Clients only explain a
 * refusal; they never decide one.
 */

/** Stable surface ids. Never rename one in flight: they are stored on sessions. */
export const DEVICE_SURFACES = [
	"web",
	"desktop",
	"self_hosted",
	"mobile",
	"extension",
	"cli",
] as const;

export type DeviceSurface = (typeof DEVICE_SURFACES)[number];

/** Session field holding the surface a session was issued to. */
export const DEVICE_SURFACE_FIELD = "surface";

/** Human-readable surface names (English literals; clients localize them). */
export const DEVICE_SURFACE_LABELS = {
	web: "Web browsers",
	desktop: "Ryu Desktop",
	self_hosted: "Self-hosted and headless Core",
	mobile: "Mobile apps",
	extension: "Browser extension",
	cli: "CLI and MCP",
} as const satisfies Record<DeviceSurface, string>;

/**
 * Default caps per surface. One table for every plan for now; the auth
 * server's policy resolver may return a different table per account.
 */
export const DEVICE_LIMIT_DEFAULTS = Object.freeze({
	web: 10,
	desktop: 5,
	self_hosted: 10,
	mobile: 5,
	extension: 5,
	cli: 5,
} as const satisfies Record<DeviceSurface, number>);

export type DeviceLimitTable = Readonly<Record<DeviceSurface, number>>;

/** Machine-readable refusal code (Better Auth `APIError` body `code`). */
export const DEVICE_LIMIT_REACHED_CODE = "DEVICE_LIMIT_REACHED";

/**
 * RFC 8628 `error` value carried by the same refusal, so device-flow pollers
 * (Core, Desktop, extension) that branch on `error` stop polling with a
 * recognisable reason instead of timing out.
 */
export const DEVICE_LIMIT_REACHED_ERROR = "device_limit_reached";

/**
 * Scope token a Ryu client may add to its device-authorization request to
 * declare its surface, e.g. `openid profile email ryu:surface:desktop`.
 *
 * Desktop, the hosted web app build of the same flow, and Core share the
 * `ryu-desktop` client id; this lets the server tell them apart at approval
 * time (`ryu:surface:desktop`, `ryu:surface:web`, `ryu:surface:self_hosted`,
 * and `ryu:surface:mobile`, which is recorded at approval time). It is a
 * provenance hint, not attestation: it only chooses which bucket a session
 * counts against, never exempts one.
 */
export const DEVICE_SURFACE_SCOPE_PREFIX = "ryu:surface:";

/**
 * Surfaces the account owner may declare for an undeclared Core grant while
 * approving it. The Ryu mobile app and the Ryu CLI have no device flow of
 * their own: each signs in through its Core node, whose grant otherwise counts
 * as self-hosted, and tags its approval link with its surface.
 */
export const APPROVAL_DECLARABLE_SURFACES: readonly DeviceSurface[] = [
	"mobile",
	"cli",
];

/**
 * Query parameter that carries an approval-time declaration from a client's
 * approval link (`/device?user_code=...&surface=mobile`, or `surface=cli`) to
 * `/device/approve`, whose request body sends it as `surface`.
 */
export const DEVICE_SURFACE_QUERY_PARAM = "surface";

/** The approval-declarable surface in `value`, or null. */
export function approvalDeclarableSurface(
	value: unknown
): DeviceSurface | null {
	return isDeviceSurface(value) && APPROVAL_DECLARABLE_SURFACES.includes(value)
		? value
		: null;
}

/** Path of the per-surface usage summary served next to `/api/sessions`. */
export const DEVICE_LIMITS_API_PATH = "/api/sessions/device-limits";

/** Wire shape of the refusal body clients receive. */
export interface DeviceLimitRefusal {
	code: typeof DEVICE_LIMIT_REACHED_CODE;
	error: typeof DEVICE_LIMIT_REACHED_ERROR;
	error_description: string;
	limit: number;
	message: string;
	surface: DeviceSurface;
}

/** One row of the `GET /api/sessions/device-limits` response. */
export interface DeviceLimitUsage {
	count: number;
	label: string;
	limit: number;
	surface: DeviceSurface;
}

/** `GET /api/sessions/device-limits` response. */
export interface DeviceLimitSummary {
	/** True when new sign-ins over a cap are refused for this account. */
	enforced: boolean;
	surfaces: DeviceLimitUsage[];
}

export function isDeviceSurface(value: unknown): value is DeviceSurface {
	return (
		typeof value === "string" &&
		(DEVICE_SURFACES as readonly string[]).includes(value)
	);
}

export function deviceSurfaceLabel(surface: DeviceSurface): string {
	return DEVICE_SURFACE_LABELS[surface];
}

/** The scope token that declares `surface`. */
export function deviceSurfaceScopeToken(surface: DeviceSurface): string {
	return `${DEVICE_SURFACE_SCOPE_PREFIX}${surface}`;
}

/** Reads a declared surface out of a space-separated scope string. */
export function declaredDeviceSurface(
	scope: string | null | undefined
): DeviceSurface | null {
	if (typeof scope !== "string" || scope.length === 0 || scope.length > 2000) {
		return null;
	}
	for (const token of scope.split(/\s+/)) {
		if (token.startsWith(DEVICE_SURFACE_SCOPE_PREFIX)) {
			const surface = token.slice(DEVICE_SURFACE_SCOPE_PREFIX.length);
			return isDeviceSurface(surface) ? surface : null;
		}
	}
	return null;
}

/** The English refusal sentence (servers send it; clients localize it). */
export function deviceLimitReachedMessage(
	surface: DeviceSurface,
	limit: number
): string {
	const noun = limit === 1 ? "device" : "devices";
	return `Device limit reached for ${deviceSurfaceLabel(surface)}: this account is already signed in on the maximum of ${limit} ${noun}. Sign out of one you no longer use, then try again.`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Recognises a device-limit refusal in any error shape a client sees: a
 * Better Auth client `{ error }` value, a thrown `APIError`, a fetch JSON
 * body, or a bare RFC 8628 `error` string. Returns null for anything else.
 */
export interface ParsedDeviceLimitRefusal {
	limit: number | null;
	surface: DeviceSurface | null;
}

export function parseDeviceLimitRefusal(
	value: unknown
): ParsedDeviceLimitRefusal | null {
	if (
		value === DEVICE_LIMIT_REACHED_ERROR ||
		value === DEVICE_LIMIT_REACHED_CODE
	) {
		return { limit: null, surface: null };
	}
	const record = readRecord(value);
	if (!record) {
		return null;
	}
	const nested = readRecord(record.body) ?? readRecord(record.error);
	if (nested && nested !== record) {
		const inner = parseDeviceLimitRefusal(nested);
		if (inner) {
			return inner;
		}
	}
	if (
		record.code !== DEVICE_LIMIT_REACHED_CODE &&
		record.error !== DEVICE_LIMIT_REACHED_ERROR
	) {
		return null;
	}
	const limit =
		typeof record.limit === "number" && Number.isFinite(record.limit)
			? record.limit
			: null;
	const surface = isDeviceSurface(record.surface) ? record.surface : null;
	return { limit, surface };
}
