// packages/core-client/src/vault/internal.ts
//
// Request helpers and internal types the Secret Vault client's area modules
// share. `../vault.ts` does not re-export them.

import type { z } from "zod";
import { apiErrorFromBody, fetchForTarget } from "../client.ts";
import type { VaultAgentTarget, VaultMachineTarget } from "./agent-routes.ts";
import type { VaultCardUseResult } from "./cards.ts";
import { VAULT_TOKEN_HEADER } from "./codecs-machine.ts";
import type { VaultItemLocation } from "./items.ts";
import type {
	VaultTransitOperation,
	VaultTransitOperations,
} from "./transit.ts";

export interface VaultExportValues {
	[name: string]: string;
}

interface VaultMachineHeaders {
	[name: string]: string;
}

export function secretPath(name: string, suffix = ""): string {
	return `/api/vault/secrets/${encodeURIComponent(name)}${suffix}`;
}

export function query(
	params: Record<string, string | number | boolean | undefined>
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

export type VaultMachineTransitCodecs = {
	[Op in Exclude<VaultTransitOperation, "rotate">]: z.ZodType<
		VaultTransitOperations[Op]["result"]
	>;
};

export async function machineRequest<T>(
	schema: z.ZodType<T>,
	target: VaultMachineTarget,
	path: string,
	options: {
		body?: unknown;
		headers?: VaultMachineHeaders;
		method?: string;
		vaultToken?: string;
	} = {}
): Promise<T> {
	const headers: VaultMachineHeaders = {
		...options.headers,
		"Content-Type": "application/json",
	};
	if (options.vaultToken) {
		headers[VAULT_TOKEN_HEADER] = options.vaultToken;
	}
	const base = target.url.replace(/\/$/, "");
	const response = await fetchForTarget(target)(`${base}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw apiErrorFromBody(path, response.status, text);
	}
	return schema.parse(text ? JSON.parse(text) : undefined);
}

export function agentRequest<T>(
	schema: z.ZodType<T>,
	target: VaultAgentTarget,
	path: string,
	options: {
		body?: unknown;
		headers?: VaultMachineHeaders;
		method?: string;
	} = {}
): Promise<T> {
	return machineRequest(schema, target, path, {
		...options,
		vaultToken: target.vaultToken,
	});
}

export function locationQuery(location: VaultItemLocation = {}): string {
	return query({ environment: location.environment, path: location.path });
}

export function itemPath(key: string, suffix = ""): string {
	return `/api/vault/items/${encodeURIComponent(key)}${suffix}`;
}

export type VaultCardPending = Extract<
	VaultCardUseResult<unknown>,
	{ status: "approval_required" }
>;

export type VaultHumanTransitCodecs = {
	[Op in VaultTransitOperation]: z.ZodType<
		VaultTransitOperations[Op]["result"]
	>;
};
