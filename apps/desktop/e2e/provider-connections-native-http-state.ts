import type {
	OAuthAccountPoolPolicy,
	PiCatalog,
	PiConfig,
	PiProvider,
} from "../src/lib/api/pi-config.ts";
export interface ProviderCall {
	body: unknown;
	jwt: string | null;
	method: string;
	path: string;
	status: number;
	token: string | null;
}
const account = (
	accountId: string,
	label: string,
	active: boolean,
	kind = "oauth"
) => ({ accountId, label, active, kind, gatewayActive: false, updatedAt: 1 });
const provider = (
	id: string,
	label: string,
	extra: Partial<PiProvider>
): PiProvider => ({
	id,
	label,
	api: "openai-completions",
	authEnv: "",
	authKind: "api-key",
	configured: true,
	custom: false,
	routing: "direct",
	suggestedModels: [],
	...extra,
});
export class ProviderState {
	calls: ProviderCall[] = [];
	unexpected: string[] = [];
	secrets: Record<string, string> = {};
	refusals = new Map<string, number>();
	holds = new Map<string, { promise: Promise<void>; release: () => void }>();
	config: PiConfig = {
		configDir: "/owned/provider-fixture",
		provider: "gateway",
		model: null,
		thinkingLevel: null,
		routing: "gateway",
	};
	policy: OAuthAccountPoolPolicy = {
		strategy: "manual",
		drainThresholdPercent: 80,
		accounts: {
			"chatgpt-a": { enabled: true, priority: 0 },
			"chatgpt-b": { enabled: true, priority: 1 },
		},
	};
	catalog: PiCatalog = {
		apiTypes: ["openai-completions"],
		thinkingLevels: ["low", "high"],
		agentModelOverrides: {},
		providers: [
			provider("chatgpt", "ChatGPT", {
				authKind: "subscription",
				supportsOAuth: true,
				supportsDiscovery: true,
				suggestedModels: ["chat-model"],
				accounts: [
					account("chatgpt-a", "ChatGPT account 1", true),
					account("chatgpt-b", "ChatGPT account 2", false),
				],
				accountRouting: {
					credentialKinds: ["oauth"],
					quotaObservations: false,
					strategies: ["manual", "round_robin"],
				},
			}),
			provider("openrouter", "OpenRouter", {
				supportsDiscovery: true,
				suggestedModels: ["remote-model"],
				accounts: [
					account("or-a", "OpenRouter key 1", true, "api_key"),
					account("or-b", "OpenRouter key 2", false, "api_key"),
				],
			}),
			provider("local-model-server", "Local model server", {
				custom: true,
				supportsDiscovery: true,
				suggestedModels: [],
				accounts: [account("local-a", "Local API key", true, "api_key")],
			}),
		],
	};
	constructor(
		readonly origin = "http://127.0.0.1:5690",
		readonly token = "provider-retry-owned-token"
	) {}
	headers() {
		return {
			"access-control-allow-origin": this.origin,
			"access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
			"access-control-allow-headers":
				"content-type,authorization,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface",
		};
	}
	output(value: unknown, status = 200) {
		return Response.json(value, { status, headers: this.headers() });
	}
	async handle(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		if (path === "/__provider-state" && method === "GET") {
			return this.output({
				calls: this.calls,
				unexpected: this.unexpected,
				config: this.config,
				catalog: this.catalog,
				policy: this.policy,
				secrets: this.secrets,
				heldRequestKeys: [...this.holds.keys()],
			});
		}
		if (
			path === "/__provider-control" &&
			method === "POST" &&
			request.headers.get("x-proof-control") === "owned-fixture"
		) {
			const action: unknown = await request.json();
			if (!action || typeof action !== "object") {
				return this.output({ error: "Invalid control" }, 400);
			}
			const a = action as Record<string, unknown>;
			if (
				a.action === "hold" &&
				typeof a.method === "string" &&
				typeof a.path === "string"
			) {
				let release!: () => void;
				const promise = new Promise<void>((resolve) => {
					release = resolve;
				});
				this.holds.set(`${a.method} ${a.path}`, { promise, release });
				return this.output({ ok: true });
			}
			if (
				a.action === "release" &&
				typeof a.method === "string" &&
				typeof a.path === "string"
			) {
				const key = `${a.method} ${a.path}`;
				const gate = this.holds.get(key);
				if (!gate) {
					return this.output({ error: "No held request" }, 400);
				}
				this.holds.delete(key);
				gate.release();
				return this.output({ ok: true });
			}
			if (a.action === "reset") {
				if (this.holds.size) {
					return this.output(
						{ error: "Reset cannot discard physical held requests" },
						409
					);
				}
				Object.assign(this, new ProviderState(this.origin, this.token));
				return this.output({ ok: true });
			}
			if (
				a.action === "refuse" &&
				typeof a.method === "string" &&
				typeof a.path === "string" &&
				typeof a.status === "number"
			) {
				this.refusals.set(
					typeof a.model === "string"
						? `${a.method} ${a.path} model=${a.model}`
						: `${a.method} ${a.path}`,
					a.status
				);
				return this.output({ ok: true });
			}
			if (
				a.action === "allow" &&
				typeof a.method === "string" &&
				typeof a.path === "string"
			) {
				this.refusals.delete(
					typeof a.model === "string"
						? `${a.method} ${a.path} model=${a.model}`
						: `${a.method} ${a.path}`
				);
				return this.output({ ok: true });
			}
			return this.output({ error: "Invalid control" }, 400);
		}
		if (!path.startsWith("/api/pi-config")) {
			return null;
		}
		const known = [
			"/api/pi-config",
			"/api/pi-config/catalog",
			"/api/pi-config/providers",
			"/api/pi-config/discover-models",
			"/api/pi-config/providers/check",
			"/api/pi-config/providers/model-enabled",
			"/api/pi-config/providers/chatgpt/account-pool",
			...["chatgpt", "openrouter", "local-model-server"].flatMap((id) => [
				`/api/pi-config/providers/${id}`,
				...["switch", "remove", "rename"].map(
					(op) => `/api/pi-config/providers/${id}/accounts/${op}`
				),
			]),
		];
		if (
			method === "OPTIONS" &&
			known.includes(path) &&
			request.headers.get("origin") === this.origin
		) {
			return new Response(null, { status: 204, headers: this.headers() });
		}
		const body: unknown = ["POST", "PUT"].includes(method)
			? await request.json()
			: null;
		const entry: ProviderCall = {
			method,
			path,
			token: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
			body,
			status: 0,
		};
		this.calls.push(entry);
		const respond = (value: unknown, status = 200) => {
			entry.status = status;
			return this.output(value, status);
		};
		const reject = (message: string) => {
			this.unexpected.push(`${method} ${path}: ${message}`);
			return respond({ error: { message } }, 400);
		};
		if (entry.token !== `Bearer ${this.token}` || entry.jwt !== null) {
			return reject("Wrong fixture authority");
		}
		if (!known.includes(path)) {
			return reject("Unknown endpoint");
		}
		const value =
			body && typeof body === "object" && !Array.isArray(body)
				? (body as Record<string, unknown>)
				: {};
		const exact = (keys: string[]) =>
			Object.keys(value).sort().join(",") === keys.sort().join(",");
		const refusal =
			this.refusals.get(`${method} ${path} model=${value.model}`) ??
			this.refusals.get(`${method} ${path}`);
		const gate = this.holds.get(`${method} ${path}`);
		if (gate) {
			await gate.promise;
		}
		if (refusal) {
			return respond(
				{ error: { message: "Owned provider operation refused" } },
				refusal
			);
		}
		if (method === "GET" && path === "/api/pi-config") {
			return respond({ config: this.config });
		}
		if (method === "GET" && path === "/api/pi-config/catalog") {
			return respond(this.catalog);
		}
		if (path.endsWith("/account-pool")) {
			if (method === "GET") {
				return respond(this.policy);
			}
			if (
				method === "PUT" &&
				exact(["strategy", "drainThresholdPercent", "accounts"]) &&
				["manual", "round_robin"].includes(String(value.strategy)) &&
				typeof value.drainThresholdPercent === "number" &&
				value.accounts &&
				typeof value.accounts === "object"
			) {
				this.policy = body as OAuthAccountPoolPolicy;
				return respond(this.policy);
			}
			return reject("Invalid account pool DTO/method");
		}
		const p = this.catalog.providers.find((item) => item.id === value.provider);
		if (
			method === "POST" &&
			path === "/api/pi-config/discover-models" &&
			exact(["provider"]) &&
			p
		) {
			return respond({
				models:
					p.id === "local-model-server"
						? [{ id: "local-a" }, { id: "local-b" }]
						: p.suggestedModels.map((id) => ({ id })),
				source: p.id === "local-model-server" ? "saved" : "pi",
			});
		}
		if (
			method === "POST" &&
			path === "/api/pi-config/providers/check" &&
			p &&
			(exact(["provider"]) || exact(["provider", "apiKey"]))
		) {
			return respond({ ok: true, latencyMs: 12, modelCount: 2 });
		}
		if (method === "POST" && path === "/api/pi-config/providers" && p) {
			if (
				exact(["provider", "apiKey"]) &&
				typeof value.apiKey === "string" &&
				value.apiKey.length
			) {
				this.secrets[p.id] = value.apiKey;
				p.configured = true;
				return respond(this.catalog);
			}
			if (
				exact(["provider", "routing"]) &&
				["direct", "gateway"].includes(String(value.routing))
			) {
				p.routing = String(value.routing);
				return respond(this.catalog);
			}
			return reject("Invalid credential/routing DTO");
		}
		if (
			method === "POST" &&
			path === "/api/pi-config/providers/model-enabled" &&
			p &&
			exact(["provider", "model", "enabled"]) &&
			typeof value.model === "string" &&
			typeof value.enabled === "boolean"
		) {
			p.modelOverrides = { ...p.modelOverrides, [value.model]: value.enabled };
			return respond(this.catalog);
		}
		if (
			method === "PUT" &&
			path === "/api/pi-config" &&
			p &&
			exact(["provider", "model", "thinkingLevel", "api"]) &&
			typeof value.model === "string" &&
			(value.api === null ||
				(typeof value.api === "string" &&
					this.catalog.apiTypes.includes(value.api))) &&
			(value.thinkingLevel === null ||
				(typeof value.thinkingLevel === "string" &&
					this.catalog.thinkingLevels.includes(value.thinkingLevel)))
		) {
			this.config = {
				...this.config,
				provider: p.id,
				model: value.model,
				thinkingLevel:
					typeof value.thinkingLevel === "string" ? value.thinkingLevel : null,
				routing: p.routing,
			};
			for (const item of this.catalog.providers) {
				item.active = item === p;
			}
			return respond({ config: this.config });
		}
		const id = path.split("/")[4];
		const selected = this.catalog.providers.find((item) => item.id === id);
		if (
			method === "DELETE" &&
			selected &&
			path === `/api/pi-config/providers/${id}`
		) {
			delete this.secrets[id!];
			if (selected.custom) {
				this.catalog.providers = this.catalog.providers.filter(
					(item) => item !== selected
				);
			} else {
				selected.configured = false;
				selected.accounts = [];
			}
			return respond(this.catalog);
		}
		const a = selected?.accounts?.find(
			(item) => item.accountId === value.accountId
		);
		if (method === "POST" && a && selected) {
			if (
				path.endsWith("/accounts/switch") &&
				exact(["accountId", "target"]) &&
				["self", "gateway"].includes(String(value.target))
			) {
				for (const item of selected.accounts ?? []) {
					if (value.target === "gateway") {
						item.gatewayActive = item === a;
					} else {
						item.active = item === a;
					}
				}
				return respond(this.catalog);
			}
			if (path.endsWith("/accounts/remove") && exact(["accountId"])) {
				selected.accounts = selected.accounts?.filter((item) => item !== a);
				return respond(this.catalog);
			}
			if (
				path.endsWith("/accounts/rename") &&
				exact(["accountId", "label"]) &&
				typeof value.label === "string" &&
				value.label.trim()
			) {
				a.label = value.label.trim();
				return respond(this.catalog);
			}
		}
		return reject("Unsupported method/body");
	}
}
