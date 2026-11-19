// Canned replies for the Vault page's admin tabs (Items, Leases, Tokens,
// Syncs) so the proof page can render them without a running Core. Nothing
// here is a real credential.

const NOW = Date.parse("2026-11-11T09:00:00Z");
const HOUR = 3_600_000;

const ITEMS = [
	{
		environment: "production",
		fieldCount: 3,
		id: "vi_login",
		key: "github-bot",
		kind: "login",
		path: "/",
		status: "ready",
		updatedAt: NOW - HOUR,
		version: 3,
	},
	{
		environment: "production",
		fieldCount: 0,
		id: "vi_card",
		key: "ops-card",
		kind: "card",
		path: "/payments",
		status: "pending_collection",
		updatedAt: NOW - 2 * HOUR,
		version: 1,
	},
];

const event = (
	seq: number,
	name: string,
	version: number,
	data: unknown,
	actorId?: string
) => ({
	actorId,
	actorKind: actorId ? "user" : "agent",
	createdAt: NOW - (10 - seq) * HOUR,
	data,
	itemId: "vi_login",
	name,
	seq,
	version,
});

const EVENTS = [
	event(1, "created", 1, { fieldsSet: ["username", "password"] }, "ada"),
	event(2, "updated", 2, { fieldsSet: ["totp"], fieldsCleared: [] }, "ada"),
	event(3, "revealed", 2, { field: "password" }),
	event(4, "updated", 3, { fieldsSet: ["password"] }, "lee"),
];

const DYNAMIC_ROLES = [
	{
		createdAt: NOW - 48 * HOUR,
		defaultTtlSecs: 3600,
		maxTtlSecs: 86_400,
		name: "app-db",
		provider: "postgres",
		summary: { host: "db.internal", database: "app" },
		updatedAt: NOW - 48 * HOUR,
	},
	{
		createdAt: NOW - 24 * HOUR,
		defaultTtlSecs: 900,
		maxTtlSecs: 3600,
		name: "deploy-aws",
		provider: "aws-sts",
		summary: { roleArn: "arn:aws:iam::123456789012:role/deploy" },
		updatedAt: NOW - 24 * HOUR,
	},
];

const lease = (
	id: string,
	role: string,
	provider: string,
	over: Record<string, unknown> = {}
) => ({
	createdAt: NOW - HOUR,
	expiresAt: NOW + 365 * 24 * HOUR,
	id,
	issuedTo: "user:ada",
	maxExpiresAt: NOW + 366 * 24 * HOUR,
	provider,
	renewable: true,
	revokedAt: null,
	role,
	...over,
});

const LEASES = [
	lease("dl_7f3a", "app-db", "postgres"),
	lease("dl_21c9", "deploy-aws", "aws-sts", {
		issuedTo: "machine:ci",
		renewable: false,
	}),
];

const TOKEN_ROLES = [
	{
		allowedPolicies: ["ci-read", "ci-write"],
		createdAt: NOW - 72 * HOUR,
		disallowedPolicies: ["root"],
		maxTtlSecs: 86_400,
		name: "ci-deploy",
		orphan: false,
		renewable: true,
		ttlSecs: 3600,
		updatedAt: NOW - 72 * HOUR,
	},
	{
		allowedPolicies: [],
		createdAt: NOW - 12 * HOUR,
		disallowedPolicies: [],
		name: "batch",
		numUses: 5,
		orphan: true,
		renewable: false,
		ttlSecs: 900,
		updatedAt: NOW - 12 * HOUR,
	},
];

const STORES = [
	{
		address: "https://bao.example.com",
		authMethod: "approle",
		id: "xs_bao",
		kind: "openbao",
		mount: "secret",
		name: "bao",
	},
];

const SOURCES = [
	{
		environment: "production",
		id: "xsrc_1",
		lastCount: 4,
		lastError: null,
		lastStatus: "ok",
		lastSyncAt: NOW - HOUR,
		mode: "sync",
		path: "/bao",
		remotePath: "apps/web",
		storeId: "xs_bao",
		syncIntervalSecs: 300,
	},
];

/** The canned reply for an admin-tab route, or `undefined` when not mocked. */
export function vaultAdminFixture(path: string): unknown {
	if (path === "/api/vault/items") {
		return { items: ITEMS };
	}
	if (path.startsWith("/api/vault/items/") && path.endsWith("/events")) {
		return { events: EVENTS, next: EVENTS.length };
	}
	switch (path) {
		case "/api/vault/dynamic/roles":
			return { roles: DYNAMIC_ROLES };
		case "/api/vault/leases":
			return { leases: LEASES };
		case "/api/vault/token-roles":
			return { roles: TOKEN_ROLES };
		case "/api/vault/external/stores":
			return { stores: STORES };
		case "/api/vault/external/sources":
			return { sources: SOURCES };
		case "/api/vault/external/destinations":
			return { destinations: [] };
		default:
			return;
	}
}
