// packages/services/src/ryu.ts
//
// `new Ryu()`: one entry point for every standalone service. Namespaces are
// lazy and memoized; nothing is resolved or fetched until the first call, so
// constructing a client never fails for a service you do not use.

import { BOX_NAMESPACE, type BoxNamespace } from "./box/namespace.ts";
import {
	assertBrowserSafe,
	type ConfigResolution,
	ENV_VARS,
	type ResolvedServiceConfig,
	type RyuOptions,
	type RyuResultMode,
	resolveServiceConfig,
} from "./config.ts";
import {
	CONNECT_NAMESPACE,
	type ConnectNamespace,
} from "./connect/namespace.ts";
import { createEnvReader, type EnvReader } from "./env.ts";
import type { RyuService } from "./errors.ts";
import {
	GATEWAY_NAMESPACE,
	type GatewayNamespace,
} from "./gateway/namespace.ts";
import { MAIL_NAMESPACE, type MailNamespace } from "./mail/namespace.ts";
import {
	MANAGED_AGENTS_NAMESPACE,
	type ManagedAgentsNamespace,
} from "./managed-agents/namespace.ts";
import {
	MESSAGING_NAMESPACE,
	type MessagingNamespace,
} from "./messaging/namespace.ts";
import { NOTIFY_NAMESPACE, type NotifyNamespace } from "./notify/namespace.ts";
import {
	type Paginated,
	type PaginateOptions,
	paginate,
} from "./pagination.ts";
import {
	PASSPORT_NAMESPACE,
	type PassportNamespace,
} from "./passport/namespace.ts";
import { createSafeProxy, type RyuResult, toResult } from "./result.ts";
import { SITES_NAMESPACE, type SitesNamespace } from "./sites/namespace.ts";
import type { ServiceFetchConfig } from "./transport/fetch-shim.ts";
import { serverUserAgent } from "./transport/user-agent.ts";
import { type VerifyWebhookOptions, verifyWebhook } from "./webhooks/index.ts";
import {
	type BoundNamespace,
	type CapabilityCache,
	type NamespaceDefinition,
	type WrapRuntime,
	wrapNamespace,
} from "./wrap.ts";

/** Every namespace's underlying client type, keyed by its `ryu.<key>`. */
export interface RyuNamespaces {
	box: BoxNamespace;
	connect: ConnectNamespace;
	gateway: GatewayNamespace;
	mail: MailNamespace;
	managedAgents: ManagedAgentsNamespace;
	messaging: MessagingNamespace;
	notify: NotifyNamespace;
	passport: PassportNamespace;
	sites: SitesNamespace;
}

/** `ryu.safe`: every namespace in object mode. */
export type SafeClient = {
	[K in keyof RyuNamespaces]: BoundNamespace<RyuNamespaces[K], "object">;
};

/** `ryu.webhooks`, in the client's result mode. */
export interface RyuWebhooks<R extends RyuResultMode = "throw"> {
	/**
	 * Verifies a delivery from Mail, Notify or Messaging and resolves to its parsed body.
	 * Throws RyuError on failure; under `result: "object"` it resolves to
	 * `{ data, error, meta }` like every other promise-returning method.
	 */
	verify(
		options: VerifyWebhookOptions
	): Promise<R extends "object" ? RyuResult<unknown> : unknown>;
}

const DEFINITIONS: {
	readonly [K in keyof RyuNamespaces]: NamespaceDefinition<RyuNamespaces[K]>;
} = {
	box: BOX_NAMESPACE,
	connect: CONNECT_NAMESPACE,
	gateway: GATEWAY_NAMESPACE,
	mail: MAIL_NAMESPACE,
	managedAgents: MANAGED_AGENTS_NAMESPACE,
	messaging: MESSAGING_NAMESPACE,
	notify: NOTIFY_NAMESPACE,
	passport: PASSPORT_NAMESPACE,
	sites: SITES_NAMESPACE,
};

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

function isNamespaceKey(key: string): key is keyof RyuNamespaces {
	return Object.hasOwn(DEFINITIONS, key);
}

/**
 * The Ryu standalone services client.
 *
 * ```ts
 * const ryu = new Ryu({ result: "object" });
 * const { data, error } = await ryu.notify.publish({ title: "Deploy finished" });
 * ```
 *
 * With the default `result: "throw"`, methods return `T` and throw RyuError;
 * `ryu.safe.<ns>.<method>()` gives the object form for one call.
 */
export class Ryu<R extends RyuResultMode = "throw"> {
	readonly #options: RyuOptions<R>;
	readonly #env: EnvReader;
	readonly #configs = new Map<string, ResolvedServiceConfig>();
	readonly #capabilities: CapabilityCache = new Map();
	readonly #namespaces = new Map<string, unknown>();
	readonly #deprecationSeen = new Set<string>();
	readonly #userAgent: string | null;
	#safe: SafeClient | undefined;

	/** Reads env lazily; throws only for a key passed in a browser without `dangerouslyAllowBrowser`. */
	constructor(options: RyuOptions<R> = {}) {
		assertBrowserSafe(options);
		this.#options = options;
		this.#env = createEnvReader(options.env);
		this.#userAgent = serverUserAgent(options.userAgent);
	}

	/** The result mode this client was built with. */
	get resultMode(): RyuResultMode {
		return this.#options.result ?? "throw";
	}

	/** Ryu Managed Agents (preview): agents, environments, credentials, sessions. */
	get managedAgents(): BoundNamespace<ManagedAgentsNamespace, R> {
		return this.#namespace("managedAgents");
	}

	/** Ryu Messaging (early access): SMS, MMS, voice, WhatsApp and phone numbers on the control plane. */
	get messaging(): BoundNamespace<MessagingNamespace, R> {
		return this.#namespace("messaging");
	}

	/** Ryu Mail, hosted (gateway key) or self-hosted (bearer). */
	get mail(): BoundNamespace<MailNamespace, R> {
		return this.#namespace("mail");
	}

	/** Ryu Notify. */
	get notify(): BoundNamespace<NotifyNamespace, R> {
		return this.#namespace("notify");
	}

	/** Ryu Box. */
	get box(): BoundNamespace<BoxNamespace, R> {
		return this.#namespace("box");
	}

	/** Ryu Gateway. */
	get gateway(): BoundNamespace<GatewayNamespace, R> {
		return this.#namespace("gateway");
	}

	/** Ryu Connect. */
	get connect(): BoundNamespace<ConnectNamespace, R> {
		return this.#namespace("connect");
	}

	/** Ryu Passport. */
	get passport(): BoundNamespace<PassportNamespace, R> {
		return this.#namespace("passport");
	}

	/** Ryu Sites (management listener). */
	get sites(): BoundNamespace<SitesNamespace, R> {
		return this.#namespace("sites");
	}

	/** Every namespace in object mode, whatever this client's `result` option. */
	get safe(): SafeClient {
		this.#safe ??= createSafeProxy<SafeClient>((key) =>
			isNamespaceKey(key) ? this.#wrap(key, "object") : undefined
		);
		return this.#safe;
	}

	/** Webhook verification (also available as `@ryuhq/services/webhooks`). */
	get webhooks(): RyuWebhooks<R> {
		const objectMode = this.resultMode === "object";
		return {
			verify: (options) =>
				(objectMode
					? toResult(verifyWebhook(options))
					: verifyWebhook(options)) as Promise<
					R extends "object" ? RyuResult<unknown> : unknown
				>,
		};
	}

	/**
	 * True when `service` can be called with this client's options and env,
	 * and was set explicitly (an env var or constructor option), not through
	 * a built-in default alone (Gateway's local URL). Resolves config only; no
	 * I/O. Used by tool registries to decide which services to expose.
	 */
	isConfigured(service: RyuService): boolean {
		let resolved: ResolvedServiceConfig;
		try {
			resolved = this.#resolve(service);
		} catch {
			return false;
		}
		// Hosted Mail selected by the ryu_ key alone (RYU_API_KEY or `apiKey`).
		if (service === "mail" && resolved.auth === "x-api-key") {
			return true;
		}
		if (
			ENV_VARS.some(
				(row) => row.service === service && this.#env(row.name) !== undefined
			)
		) {
			return true;
		}
		const scoped: unknown = (this.#options as Record<string, unknown>)[service];
		if (
			typeof scoped === "object" &&
			scoped !== null &&
			Object.values(scoped).some((value) => value !== undefined)
		) {
			return true;
		}
		return (
			(service === "managedAgents" || service === "messaging") &&
			this.#options.apiKey !== undefined
		);
	}

	/**
	 * True when `service` has methods whose route needs no credential
	 * (Messaging `status()`, and hosted Mail `status()` on the control-plane
	 * origin) and this client can call them: the service's URL resolves even
	 * though its credentials may not. Those calls then send no key. False for
	 * every other service, for self-hosted Mail (whose status route needs its
	 * bearer) and for an invalid URL. Resolves config only; no I/O. The
	 * `ryu-services mcp` server uses it to register the credential-free
	 * status tools of a service that is not configured.
	 */
	canCallWithoutCredentials(service: RyuService): boolean {
		const definition = DEFINITIONS[service] as NamespaceDefinition<unknown>;
		if ((definition.credentialFreeMethods ?? []).length === 0) {
			return false;
		}
		try {
			this.#resolve(service, { credentials: "optional" });
			return true;
		} catch {
			return false;
		}
	}

	/** Iterates any cursor-paginated list with the SDK's iterator shape. */
	iterate<Page, Item>(
		options: PaginateOptions<Page, Item>
	): Paginated<Item, Page> {
		return paginate(options);
	}

	#namespace<K extends keyof RyuNamespaces>(
		key: K
	): BoundNamespace<RyuNamespaces[K], R> {
		return this.#wrap(key, this.resultMode) as BoundNamespace<
			RyuNamespaces[K],
			R
		>;
	}

	#wrap(key: keyof RyuNamespaces, mode: RyuResultMode): unknown {
		const cacheKey = `${key}:${mode}`;
		let namespace = this.#namespaces.get(cacheKey);
		if (namespace === undefined) {
			namespace = wrapNamespace(
				this.#runtime(),
				DEFINITIONS[key] as NamespaceDefinition<unknown>,
				mode
			);
			this.#namespaces.set(cacheKey, namespace);
		}
		return namespace;
	}

	#runtime(): WrapRuntime {
		return {
			capabilityCache: this.#capabilities,
			resolveConfig: (service, resolution) =>
				this.#resolve(service, resolution),
			shimConfig: (config, definition) => this.#shimConfig(config, definition),
		};
	}

	#resolve(
		service: RyuService,
		resolution?: ConfigResolution
	): ResolvedServiceConfig {
		const cacheKey =
			resolution?.credentials === "optional" ? `${service}:optional` : service;
		let config = this.#configs.get(cacheKey);
		if (config === undefined) {
			config = resolveServiceConfig(
				service,
				this.#options,
				this.#env,
				resolution
			);
			this.#configs.set(cacheKey, config);
		}
		return config;
	}

	#shimConfig(
		config: ResolvedServiceConfig,
		definition: NamespaceDefinition<unknown>
	): ServiceFetchConfig {
		const options = this.#options;
		return {
			apiKey: config.apiKey,
			auth: config.auth,
			autoIdempotency: options.autoIdempotency ?? true,
			baseUrl: config.baseUrl,
			deprecationSeen: this.#deprecationSeen,
			errors: definition.errors,
			fetch: options.fetch,
			hooks: options.hooks,
			maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
			maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
			refineError: definition.refineError,
			refineErrorCode: definition.refineErrorCode,
			routes: definition.routes,
			selectKey: definition.selectKey?.(config),
			service: config.service,
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			userAgent: this.#userAgent,
		};
	}
}
