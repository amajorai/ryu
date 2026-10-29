import { ApiError, type ApiTarget, request } from "./client.ts";
import {
	type GatewayProviderApplication,
	type GatewayProviderEditResult,
	requireGatewayProviderReload,
} from "./gateway.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import {
	gatewayWebAccountsSchema,
	webAccountApplicationSchema,
	webAccountRevisionSchema,
	webAccountSavedSchema,
} from "./web-account-wire-contracts.ts";

export type GatewayWebProvider =
	| "tavily"
	| "brave"
	| "serper"
	| "exa"
	| "linkup"
	| "parallel"
	| "perplexity-search"
	| "google-pse"
	| "searchapi"
	| "firecrawl"
	| "jina-reader";
export type GatewayWebContext =
	| { kind: "default" }
	| {
			kind: "google_pse";
			engine_id: string;
			existing_customer_acknowledged: boolean;
	  }
	| { kind: "search_api"; engine: "google" };
export interface GatewayWebPolicy {
	enabled: boolean;
	name: string;
	priority: number;
}
export interface GatewayWebAccount {
	accountId: string;
	context: GatewayWebContext;
	diagnostic: "existing_customer_required" | "google_pse_discontinued" | null;
	policy: GatewayWebPolicy;
}
export interface GatewayWebConnection {
	accounts: GatewayWebAccount[];
	anonymous: boolean;
	provider: GatewayWebProvider;
}
export interface GatewayWebAccountsView {
	configRevision: string;
	providers: GatewayWebConnection[];
	webServiceSchema: 1;
}

export const GATEWAY_WEB_PROVIDERS: readonly {
	id: GatewayWebProvider;
	label: string;
	brand: string;
	operations: readonly ("search" | "fetch")[];
}[] = [
	{
		id: "tavily",
		label: "Tavily",
		brand: "tavily",
		operations: ["search", "fetch"],
	},
	{ id: "exa", label: "Exa", brand: "exa", operations: ["search", "fetch"] },
	{
		id: "brave",
		label: "Brave Search",
		brand: "brave",
		operations: ["search"],
	},
	{ id: "serper", label: "Serper", brand: "serper", operations: ["search"] },
	{ id: "linkup", label: "Linkup", brand: "linkup", operations: ["search"] },
	{
		id: "parallel",
		label: "Parallel",
		brand: "parallel",
		operations: ["search"],
	},
	{
		id: "perplexity-search",
		label: "Perplexity Search",
		brand: "perplexity",
		operations: ["search"],
	},
	{
		id: "google-pse",
		label: "Google Custom Search",
		brand: "google",
		operations: ["search"],
	},
	{
		id: "searchapi",
		label: "SearchAPI",
		brand: "searchapi",
		operations: ["search"],
	},
	{
		id: "firecrawl",
		label: "Firecrawl",
		brand: "firecrawl",
		operations: ["fetch"],
	},
	{
		id: "jina-reader",
		label: "Jina Reader",
		brand: "jina",
		operations: ["fetch"],
	},
];

function malformed(): Error {
	return new Error(
		"Gateway returned an invalid web account view. Refresh or update this node."
	);
}
export function parseGatewayWebAccounts(
	value: Parameters<typeof gatewayWebAccountsSchema.parse>[0]
): GatewayWebAccountsView {
	const parsed = gatewayWebAccountsSchema.safeParse(value);
	if (!parsed.success) {
		throw malformed();
	}
	return parsed.data;
}

export async function getGatewayWebAccounts(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayWebAccountsView> {
	try {
		return parseGatewayWebAccounts(
			await request(
				target,
				"/api/gateway/web-accounts",
				{ signal },
				gatewayJsonValueSchema
			)
		);
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.status === 404 || error.status === 405)
		) {
			throw new Error(
				"This node does not support the protected web account editor. Update Core and Gateway."
			);
		}
		throw error;
	}
}

export type GatewayWebAccountEdit =
	| {
			action: "context";
			provider: GatewayWebProvider;
			accountId: string;
			context: GatewayWebContext;
	  }
	| {
			action: "add";
			provider: GatewayWebProvider;
			apiKey: string;
			context: GatewayWebContext;
	  }
	| {
			action: "replace";
			provider: GatewayWebProvider;
			accountId: string;
			apiKey: string;
			context: GatewayWebContext;
	  }
	| {
			action: "configure";
			provider: GatewayWebProvider;
			accountId: string;
			accountPolicy: GatewayWebPolicy;
	  }
	| { action: "remove"; provider: GatewayWebProvider; accountId: string }
	| { action: "anonymous" | "clear"; provider: GatewayWebProvider };

export class GatewayWebAccountSavedError extends Error {
	readonly savedRevision: string;
	constructor(message: string, savedRevision: string) {
		super(message);
		this.name = "GatewayWebAccountSavedError";
		this.savedRevision = savedRevision;
	}
}

function requireApplied(
	value: Parameters<typeof webAccountSavedSchema.parse>[0]
): GatewayProviderEditResult {
	const saved = webAccountSavedSchema.safeParse(value);
	if (!saved.success) {
		throw new Error(
			"Gateway did not confirm that the web account edit was saved. Keep the draft and refresh the node."
		);
	}

	try {
		const result: GatewayProviderEditResult = {
			success: true,
			persisted: true,
			configRevision: saved.data.configRevision,
			gateway_restarted: false,
			gateway_application: parseApplication(saved.data.gateway_application),
		};
		if (!result.gateway_application) {
			throw new Error(
				"Connection saved, but Gateway did not confirm live application. Refresh the node before applying saved settings."
			);
		}
		requireGatewayProviderReload(result);
		return result;
	} catch (error) {
		throw new GatewayWebAccountSavedError(
			error instanceof Error
				? error.message
				: "Connection saved, but live application is unconfirmed.",
			saved.data.configRevision
		);
	}
}

export async function editGatewayWebAccount(
	target: ApiTarget,
	expectedRevision: string,
	edit: GatewayWebAccountEdit,
	signal?: AbortSignal
): Promise<GatewayProviderEditResult> {
	if (!webAccountRevisionSchema.safeParse(expectedRevision).success) {
		throw new Error(
			"Refresh the web account view before editing. Its saved revision is required."
		);
	}
	return requireApplied(
		await request(
			target,
			"/api/gateway/web-accounts",
			{
				method: "PUT",
				body: { ...edit, expectedRevision },
				signal,
			},
			gatewayJsonValueSchema
		)
	);
}

export async function applyGatewayWebAccounts(
	target: ApiTarget,
	savedRevision: string,
	signal?: AbortSignal
): Promise<GatewayProviderEditResult> {
	if (!webAccountRevisionSchema.safeParse(savedRevision).success) {
		throw new Error(
			"Refresh the saved web account revision before applying it."
		);
	}
	const result = await request(
		target,
		"/api/gateway/providers/apply",
		{ method: "POST", body: { revision: savedRevision }, signal },
		gatewayJsonValueSchema
	);
	return requireApplied(result);
}

export function sameGatewayWebTarget(
	left: ApiTarget,
	right: ApiTarget
): boolean {
	return (
		left.url === right.url &&
		left.token === right.token &&
		left.userJwt === right.userJwt
	);
}

function parseApplication(
	value: Parameters<typeof webAccountApplicationSchema.parse>[0]
): GatewayProviderApplication | undefined {
	const parsed = webAccountApplicationSchema.safeParse(value);
	if (!parsed.success) {
		throw malformed();
	}
	return parsed.data;
}
