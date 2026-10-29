import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import {
	ApiError,
	type ApiTarget,
	request as coreRequest,
	type RequestOptions,
} from "@ryuhq/core-client/client";
import { z } from "zod";
import { accountBackendTarget } from "./authBackend.ts";
import { type CliStateEnvironment, cliStatePath } from "./cliStatePath.ts";
import { withCoreIdentityCheck } from "./coreIdentity.ts";
import { fetchManagedNodes } from "./managedNodes.ts";
import type { Node } from "./nodes.ts";

export const PRODUCT_MODES = ["bot", "console", "os"] as const;
export type ProductMode = (typeof PRODUCT_MODES)[number];
export type StartupRealm = "last-used" | ProductMode;

export const STARTUP_REALM_OPTIONS = [
	{ label: "Last used", value: "last-used" },
	{ label: "Bot", value: "bot" },
	{ label: "Agent", value: "console" },
	{ label: "OS", value: "os" },
] as const satisfies readonly { label: string; value: StartupRealm }[];

type ProductModeSurfaces = Record<ProductMode, string>;

export const PRODUCT_MODE_DEFAULT_SURFACES = {
	bot: "/chat",
	console: "/home",
	os: "/app-launcher",
} satisfies ProductModeSurfaces;

const CLOUD_SELECTION_KEY = "default-cloud-agent-selection";
const MANAGED_PROVIDER = "managed-openrouter";
const MANAGED_MODEL = "openrouter/auto";

export interface ProductModePreference {
	mode: ProductMode;
	startupRealm: StartupRealm;
	surfaces: ProductModeSurfaces;
	version: 1;
}

export interface ProductModeIssue {
	kind:
		| "console-denied"
		| "control-plane-unavailable"
		| "managed-workspace-pending"
		| "subscription-required"
		| "cloud-lane-write-failed";
	message: string;
}

export type ProductModeActivation =
	| {
			cloudLane: "not-applicable" | "preserved" | "seeded" | "unavailable";
			managedAccess:
				| "available"
				| "control-plane-unavailable"
				| "subscription-required"
				| "workspace-pending";
			mode: ProductMode;
			notice?: ProductModeIssue;
			ok: true;
			surface: string;
			target: ApiTarget;
	  }
	| { issue: ProductModeIssue; ok: false };

export type ProductModeRequest = (
	target: ApiTarget,
	path: string,
	options?: RequestOptions
) => ReturnType<typeof coreRequest>;

export interface ProductModeServices {
	fetchManagedNodes: (target: ApiTarget) => Promise<Node[] | null>;
	request: ProductModeRequest;
}

const DEFAULT_PREFERENCE: ProductModePreference = {
	mode: "bot",
	startupRealm: "last-used",
	surfaces: { ...PRODUCT_MODE_DEFAULT_SURFACES },
	version: 1,
};

function containsUnsafePathCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f || character === "\\") {
			return true;
		}
	}
	return false;
}

const safeSurfaceSchema = z
	.string()
	.refine(
		(value) =>
			value.startsWith("/") &&
			value.length <= 512 &&
			!containsUnsafePathCharacter(value) &&
			!value.split("/").includes("..")
	);
const productModePreferenceSchema = z.object({
	mode: z.enum(PRODUCT_MODES).catch("bot"),
	startupRealm: z.enum(["last-used", ...PRODUCT_MODES]).catch("last-used"),
	surfaces: z
		.object({
			bot: safeSurfaceSchema.catch(PRODUCT_MODE_DEFAULT_SURFACES.bot),
			console: safeSurfaceSchema.catch(PRODUCT_MODE_DEFAULT_SURFACES.console),
			os: safeSurfaceSchema.catch(PRODUCT_MODE_DEFAULT_SURFACES.os),
		})
		.catch({ ...PRODUCT_MODE_DEFAULT_SURFACES }),
});
const accountStatusSchema = z.object({
	authenticated: z.boolean().catch(false),
	token: z.string().trim().min(1).nullable().catch(null),
});
const agentSelectionSchema = z.object({
	agent_id: z.string().optional().catch(undefined),
	provider: z.string().optional().catch(undefined),
	model: z.string().optional().catch(undefined),
	thinking_level: z.string().optional().catch(undefined),
	effort: z.string().optional().catch(undefined),
	access_mode: z.string().optional().catch(undefined),
});
const cloudSelectionPreferenceSchema = z.object({ value: z.string() });
const subscriptionStatusSchema = z.object({
	entitlement: z
		.object({ managedInference: z.boolean().catch(false) })
		.nullable()
		.catch(null),
});
const effectivePermissionsSchema = z.object({
	permissions: z.array(z.string()),
});

/**
 * The effective permission that admits a caller to Console on a managed node.
 * It is the permission Core and the control plane enforce on node configuration,
 * so built-in owners/admins and any custom role that grants it qualify. Mirrors
 * the desktop `CONSOLE_PERMISSION`.
 */
export const CONSOLE_PERMISSION = "gateway.configure";

export function defaultProductModePreference(): ProductModePreference {
	return {
		mode: DEFAULT_PREFERENCE.mode,
		startupRealm: DEFAULT_PREFERENCE.startupRealm,
		surfaces: { ...DEFAULT_PREFERENCE.surfaces },
		version: DEFAULT_PREFERENCE.version,
	};
}

/** Resolve the startup setting before applying the usual mode access gates. */
export function resolveStartupProductMode(
	preference: Pick<ProductModePreference, "mode" | "startupRealm">
): ProductMode {
	return preference.startupRealm === "last-used"
		? preference.mode
		: preference.startupRealm;
}

/** `<data dir>/state/cli/cli-product-mode.json`. `home` overrides the user
 * home the profile-default data dir hangs off. */
export function productModePreferencePath(
	home?: string,
	environment: CliStateEnvironment = process.env
): string {
	return cliStatePath(
		"cli-product-mode.json",
		home === undefined
			? environment
			: { ...environment, HOME: home, USERPROFILE: home }
	);
}

/** A node is explicitly unmanaged when it was configured locally or is this
 * machine's loopback Core. Managed node delegations carry userJwt and are never
 * classified as unmanaged. */
export function isKnownUnmanagedTarget(
	target: ApiTarget,
	configuredUrls: readonly string[] = []
): boolean {
	if (target.userJwt) {
		return false;
	}
	const normalized = target.url.replace(/\/$/, "");
	const configured = [
		...configuredUrls,
		process.env.RYU_CORE_URL?.trim() ?? "",
	].some((url) => url.length > 0 && url.replace(/\/$/, "") === normalized);
	if (configured) {
		return true;
	}
	try {
		const { hostname } = new URL(target.url);
		return (
			hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
		);
	} catch {
		return false;
	}
}

export function parseProductModePreference(
	value: Parameters<typeof productModePreferenceSchema.safeParse>[0]
): ProductModePreference {
	const parsed = productModePreferenceSchema.safeParse(value);
	return parsed.success
		? { ...parsed.data, version: 1 }
		: defaultProductModePreference();
}

export function readProductModePreference(
	filePath = productModePreferencePath()
): ProductModePreference {
	try {
		return parseProductModePreference(
			JSON.parse(readFileSync(filePath, "utf8"))
		);
	} catch {
		return defaultProductModePreference();
	}
}

export function writeProductModePreference(
	preference: ProductModePreference,
	filePath = productModePreferencePath()
): ProductModePreference {
	const normalized = parseProductModePreference(preference);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
		mode: 0o600,
	});
	return normalized;
}

export function withProductMode(
	preference: ProductModePreference,
	mode: ProductMode,
	surface = PRODUCT_MODE_DEFAULT_SURFACES[mode]
): ProductModePreference {
	const current = parseProductModePreference(preference);
	return parseProductModePreference({
		...current,
		mode,
		surfaces: { ...current.surfaces, [mode]: surface },
	});
}

export function withProductModeSurface(
	preference: ProductModePreference,
	mode: ProductMode,
	surface: string
): ProductModePreference {
	return withProductMode(preference, mode, surface);
}

export function withStartupRealm(
	preference: ProductModePreference,
	startupRealm: StartupRealm
): ProductModePreference {
	const current = parseProductModePreference(preference);
	return parseProductModePreference({ ...current, startupRealm });
}

function controlPlaneIssue(): ProductModeIssue {
	return {
		kind: "control-plane-unavailable",
		message:
			"Could not verify account or managed-node access. The current mode and node were left unchanged; press r to retry.",
	};
}

function accountTokenFrom(
	value: Parameters<typeof accountStatusSchema.safeParse>[0]
): string | null {
	const parsed = accountStatusSchema.safeParse(value);
	return parsed.success && parsed.data.authenticated ? parsed.data.token : null;
}

interface AccountTargetResult {
	target: ApiTarget | null;
	unavailable: boolean;
}

async function getAccountTarget(
	sourceTarget: ApiTarget,
	request: ProductModeRequest
): Promise<AccountTargetResult> {
	try {
		const status = await request(sourceTarget, "/api/auth/status");
		const token = accountTokenFrom(status);
		return {
			target: token ? accountBackendTarget(token) : null,
			unavailable: false,
		};
	} catch {
		return { target: null, unavailable: true };
	}
}

function isEmptyAgentSelection(raw: string | null): boolean {
	const value = raw?.trim() ?? "";
	if (!value) {
		return true;
	}
	if (!value.startsWith("{")) {
		return false;
	}
	try {
		const selection = agentSelectionSchema.safeParse(JSON.parse(value));
		return !(
			selection.success &&
			Object.values(selection.data).some(
				(field) => field !== undefined && field.trim().length > 0
			)
		);
	} catch {
		return true;
	}
}

async function seedManagedCloudLane(
	target: ApiTarget,
	request: ProductModeRequest
): Promise<"preserved" | "seeded" | "unavailable"> {
	let current: string | null = null;
	try {
		const preference = await request(
			target,
			`/api/preferences/${CLOUD_SELECTION_KEY}`
		);
		const parsed = cloudSelectionPreferenceSchema.safeParse(preference);
		if (!parsed.success) {
			return "unavailable";
		}
		current = parsed.data.value;
	} catch (error) {
		if (!(error instanceof ApiError && error.status === 404)) {
			return "unavailable";
		}
	}
	if (!isEmptyAgentSelection(current)) {
		return "preserved";
	}
	const selection = {
		access_mode: "",
		agent_id: "ryu",
		effort: "",
		model: MANAGED_MODEL,
		provider: MANAGED_PROVIDER,
		thinking_level: "",
	};
	const value = JSON.stringify(selection);
	try {
		await request(target, `/api/preferences/${CLOUD_SELECTION_KEY}`, {
			method: "PUT",
			body: { value },
		});
		const saved = await request(
			target,
			`/api/preferences/${CLOUD_SELECTION_KEY}`
		);
		const parsed = cloudSelectionPreferenceSchema.safeParse(saved);
		return parsed.success && parsed.data.value === value
			? "seeded"
			: "unavailable";
	} catch {
		return "unavailable";
	}
}

function cloudNodeTarget(node: Node): ApiTarget {
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	if (node.userJwt) {
		target.userJwt = node.userJwt;
	}
	return withCoreIdentityCheck(target);
}

function matchingNode(nodes: readonly Node[], url: string): Node | undefined {
	const normalized = url.replace(/\/$/, "");
	return nodes.find((node) => node.url.replace(/\/$/, "") === normalized);
}

export interface ProductModeActivationOptions {
	activeTarget: ApiTarget;
	authSourceTarget: ApiTarget;
	fetchManagedNodes?: ProductModeServices["fetchManagedNodes"];
	knownUnmanagedTarget: boolean;
	preference: ProductModePreference;
	request?: ProductModeRequest;
}

export async function activateProductMode(
	mode: ProductMode,
	options: ProductModeActivationOptions
): Promise<ProductModeActivation> {
	const request =
		options.request ??
		((target, path, init) =>
			coreRequest(target, path, init, appResponseValueSchema));
	const fetchNodes = options.fetchManagedNodes ?? fetchManagedNodes;
	const surface = parseProductModePreference(options.preference).surfaces[mode];
	if (mode === "os") {
		return {
			cloudLane: "not-applicable",
			managedAccess: "available",
			mode,
			ok: true,
			surface,
			target: options.activeTarget,
		};
	}

	if (mode === "bot") {
		const account = await getAccountTarget(options.authSourceTarget, request);
		if (account.unavailable) {
			return {
				cloudLane: "not-applicable",
				managedAccess: "control-plane-unavailable",
				mode,
				notice: controlPlaneIssue(),
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}
		if (!account.target) {
			return {
				cloudLane: "not-applicable",
				managedAccess: "subscription-required",
				mode,
				notice: {
					kind: "subscription-required",
					message:
						"Managed Bot routing requires a signed-in account. This CLI will keep chatting through the current node; review your plan in Settings → Account.",
				},
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}
		let subscription: z.infer<typeof subscriptionStatusSchema> | null;
		try {
			const parsed = subscriptionStatusSchema.safeParse(
				await request(account.target, "/api/billing/subscription-status")
			);
			subscription = parsed.success ? parsed.data : null;
		} catch {
			return {
				cloudLane: "not-applicable",
				managedAccess: "control-plane-unavailable",
				mode,
				notice: controlPlaneIssue(),
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}
		const entitlement = subscription?.entitlement;
		if (entitlement?.managedInference !== true) {
			return {
				cloudLane: "not-applicable",
				managedAccess: "subscription-required",
				mode,
				notice: {
					kind: "subscription-required",
					message:
						"Managed Bot routing requires an active subscription. This CLI will keep chatting through the current node; review your plan in Settings → Account.",
				},
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}

		let nodes: Node[] | null;
		try {
			nodes = await fetchNodes(options.authSourceTarget);
		} catch {
			nodes = null;
		}
		if (nodes === null) {
			return {
				cloudLane: "not-applicable",
				managedAccess: "control-plane-unavailable",
				mode,
				notice: controlPlaneIssue(),
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}
		const eligible = nodes.filter(
			(node) => node.managed === true && node.url.trim().length > 0
		);
		if (eligible.length === 0) {
			return {
				cloudLane: "not-applicable",
				managedAccess: "workspace-pending",
				mode,
				notice: {
					kind: "managed-workspace-pending",
					message:
						"Your subscription is active, but its managed workspace is not ready. This CLI will keep the current node; press r to retry.",
				},
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}
		const node =
			matchingNode(eligible, options.activeTarget.url) ?? eligible[0];
		if (!node.userJwt) {
			return {
				cloudLane: "not-applicable",
				managedAccess: "workspace-pending",
				mode,
				notice: {
					kind: "managed-workspace-pending",
					message:
						"The managed workspace did not return its scoped session delegation. This CLI will keep the current node; press r to retry.",
				},
				ok: true,
				surface,
				target: options.activeTarget,
			};
		}
		const target = cloudNodeTarget(node);
		const cloudLane = await seedManagedCloudLane(target, request);
		const activation: ProductModeActivation = {
			cloudLane,
			managedAccess: "available",
			mode,
			ok: true,
			surface,
			target,
		};
		if (cloudLane === "unavailable") {
			activation.notice = {
				kind: "cloud-lane-write-failed",
				message:
					"Managed chat is eligible, but its default cloud lane could not be saved. The current chat still works; press r in this mode picker to retry.",
			};
		}
		return activation;
	}

	if (options.knownUnmanagedTarget && !options.activeTarget.userJwt) {
		return {
			cloudLane: "not-applicable",
			managedAccess: "available",
			mode,
			ok: true,
			surface,
			target: options.activeTarget,
		};
	}
	const account = await getAccountTarget(options.authSourceTarget, request);
	if (account.unavailable) {
		return { issue: controlPlaneIssue(), ok: false };
	}
	if (!account.target) {
		return {
			issue: {
				kind: "console-denied",
				message:
					"Agent access on managed nodes requires a signed-in organization member whose role grants Gateway configuration. The current surface was left unchanged.",
			},
			ok: false,
		};
	}
	let managedNodes: Node[] | null;
	try {
		managedNodes = await fetchNodes(options.authSourceTarget);
	} catch {
		managedNodes = null;
	}
	if (managedNodes === null) {
		return { issue: controlPlaneIssue(), ok: false };
	}
	const node = matchingNode(managedNodes, options.activeTarget.url);
	if (!node) {
		if (options.activeTarget.userJwt || !options.knownUnmanagedTarget) {
			return {
				issue: {
					kind: "console-denied",
					message:
						"Agent access could not be verified for this node. Choose a configured local node or retry the account check.",
				},
				ok: false,
			};
		}
		return {
			cloudLane: "not-applicable",
			managedAccess: "available",
			mode,
			ok: true,
			surface,
			target: options.activeTarget,
		};
	}
	if (!node.orgId) {
		return {
			issue: {
				kind: "console-denied",
				message:
					"Agent access could not be verified because the managed node has no organization binding.",
			},
			ok: false,
		};
	}
	// Effective permissions (built-in role tier plus custom roles), as the
	// control plane resolves them. A caller outside the node's organization is
	// refused with 403, which denies Console rather than reporting an outage.
	// A malformed payload grants nothing.
	let permissions: string[];
	try {
		const parsed = effectivePermissionsSchema.safeParse(
			await request(
				account.target,
				`/api/control-plane/me/permissions?orgId=${encodeURIComponent(node.orgId)}`
			)
		);
		permissions = parsed.success ? parsed.data.permissions : [];
	} catch (error) {
		if (!(error instanceof ApiError && error.status === 403)) {
			return { issue: controlPlaneIssue(), ok: false };
		}
		permissions = [];
	}
	if (!permissions.includes(CONSOLE_PERMISSION)) {
		return {
			issue: {
				kind: "console-denied",
				message:
					"Agent is available on this managed node only to organization members whose role grants Gateway configuration. The current surface was left unchanged.",
			},
			ok: false,
		};
	}
	return {
		cloudLane: "not-applicable",
		managedAccess: "available",
		mode,
		ok: true,
		surface,
		target: options.activeTarget,
	};
}
