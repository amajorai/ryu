import type {
	NativeAccount,
	NativeLoginOperation,
} from "@ryuhq/core-client/native-accounts.ts";
import {
	nativeAccountResponseSchema,
	nativeLoginOperationResponseSchema,
} from "@ryuhq/core-client/native-accounts.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

function base(agentId: string) {
	return `/api/agents/${encodeURIComponent(agentId)}/native-accounts`;
}

// Desktop owns session exchange and identity headers; the shared client owns DTOs.
export function listNativeAccounts(target: ApiTarget, agentId: string) {
	return request<{ accounts: NativeAccount[]; nativeAccounts: true }>(
		target,
		base(agentId),
		{},
		z
			.object({
				accounts: z.array(nativeAccountResponseSchema),
				nativeAccounts: z.literal(true),
			})
			.passthrough()
	);
}
export function createNativeAccount(
	target: ApiTarget,
	agentId: string,
	label: string
) {
	return request<{ account: NativeAccount }>(
		target,
		base(agentId),
		{
			method: "POST",
			body: { label },
		},
		z.object({ account: nativeAccountResponseSchema }).passthrough()
	);
}
export function startNativeAccountLogin(
	target: ApiTarget,
	agentId: string,
	accountId: string
) {
	return request<{
		accountId: string;
		operationId: string;
		state: "running";
		verified: false;
	}>(
		target,
		`${base(agentId)}/${encodeURIComponent(accountId)}/login`,
		{
			method: "POST",
		},
		z
			.object({
				accountId: z.string(),
				operationId: z.string(),
				state: z.literal("running"),
				verified: z.literal(false),
			})
			.passthrough()
	);
}
export function nativeAccountLoginProgress(
	target: ApiTarget,
	agentId: string,
	operationId: string
) {
	return request<{ operation: NativeLoginOperation }>(
		target,
		`${base(agentId)}/operations/${encodeURIComponent(operationId)}`,
		{},
		z.object({ operation: nativeLoginOperationResponseSchema }).passthrough()
	);
}
export function cancelNativeAccountLogin(
	target: ApiTarget,
	agentId: string,
	operationId: string
) {
	return request<{ cancelled: boolean }>(
		target,
		`${base(agentId)}/operations/${encodeURIComponent(operationId)}`,
		{ method: "DELETE" },
		z.object({ cancelled: z.boolean() }).passthrough()
	);
}
export function disconnectNativeAccount(
	target: ApiTarget,
	agentId: string,
	accountId: string
) {
	return request<{ disconnected: boolean }>(
		target,
		`${base(agentId)}/${encodeURIComponent(accountId)}/disconnect`,
		{ method: "POST" },
		z.object({ disconnected: z.boolean() }).passthrough()
	);
}
export function logoutNativeAccount(
	target: ApiTarget,
	agentId: string,
	accountId: string
) {
	return request<{ loggedOut: boolean }>(
		target,
		`${base(agentId)}/${encodeURIComponent(accountId)}/logout`,
		{ method: "POST" },
		z.object({ loggedOut: z.boolean() }).passthrough()
	);
}
