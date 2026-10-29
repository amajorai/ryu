import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

function nativeAccountResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const nativeAccountResponseSchema = nativeAccountResponse(
	z.object({
		accountId: z.string(),
		active: z.boolean(),
		kind: z.literal("native_cli"),
		label: z.string(),
		state: z.enum(["pending", "connected", "disconnected"]),
		verified: z.boolean(),
	})
);
export const nativeLoginOperationResponseSchema = nativeAccountResponse(
	z.object({
		accountId: z.string(),
		error: z.string().nullable(),
		instructions: z.string(),
		operationId: z.string(),
		state: z.enum(["running", "completed", "failed"]),
	})
);
const nativeAccountsListResponseSchema = nativeAccountResponse(
	z.object({
		accounts: z.array(nativeAccountResponseSchema),
		nativeAccounts: z.literal(true),
	})
);
const nativeAccountCreateResponseSchema = nativeAccountResponse(
	z.object({ account: nativeAccountResponseSchema })
);
const nativeAccountLoginResponseSchema = nativeAccountResponse(
	z.object({
		accountId: z.string(),
		operationId: z.string(),
		state: z.literal("running"),
		verified: z.literal(false),
	})
);
const nativeAccountProgressResponseSchema = nativeAccountResponse(
	z.object({ operation: nativeLoginOperationResponseSchema })
);
const nativeAccountCancelResponseSchema = nativeAccountResponse(
	z.object({ cancelled: z.boolean() })
);
const nativeAccountDisconnectResponseSchema = nativeAccountResponse(
	z.object({ disconnected: z.boolean() })
);
const nativeAccountLogoutResponseSchema = nativeAccountResponse(
	z.object({ loggedOut: z.boolean() })
);

export interface NativeAccount {
	accountId: string;
	active: boolean;
	kind: "native_cli";
	label: string;
	state: "pending" | "connected" | "disconnected";
	verified: boolean;
}

export interface NativeLoginOperation {
	accountId: string;
	error: string | null;
	instructions: string;
	operationId: string;
	state: "running" | "completed" | "failed";
}

function base(agentId: string): string {
	return `/api/agents/${encodeURIComponent(agentId)}/native-accounts`;
}

export async function listNativeAccounts(target: ApiTarget, agentId: string) {
	return await request(
		target,
		base(agentId),
		{},
		nativeAccountsListResponseSchema
	);
}

export async function createNativeAccount(
	target: ApiTarget,
	agentId: string,
	label: string
) {
	return await request(
		target,
		base(agentId),
		{
			method: "POST",
			body: { label },
		},
		nativeAccountCreateResponseSchema
	);
}

export async function startNativeAccountLogin(
	target: ApiTarget,
	agentId: string,
	accountId: string
) {
	return await request(
		target,
		`${base(agentId)}/${encodeURIComponent(accountId)}/login`,
		{
			method: "POST",
		},
		nativeAccountLoginResponseSchema
	);
}

export async function nativeAccountLoginProgress(
	target: ApiTarget,
	agentId: string,
	operationId: string
) {
	return await request(
		target,
		`${base(agentId)}/operations/${encodeURIComponent(operationId)}`,
		{},
		nativeAccountProgressResponseSchema
	);
}

export async function cancelNativeAccountLogin(
	target: ApiTarget,
	agentId: string,
	operationId: string
) {
	return await request(
		target,
		`${base(agentId)}/operations/${encodeURIComponent(operationId)}`,
		{ method: "DELETE" },
		nativeAccountCancelResponseSchema
	);
}

export async function disconnectNativeAccount(
	target: ApiTarget,
	agentId: string,
	accountId: string
) {
	return await request(
		target,
		`${base(agentId)}/${encodeURIComponent(accountId)}/disconnect`,
		{ method: "POST" },
		nativeAccountDisconnectResponseSchema
	);
}

export async function logoutNativeAccount(
	target: ApiTarget,
	agentId: string,
	accountId: string
) {
	return await request(
		target,
		`${base(agentId)}/${encodeURIComponent(accountId)}/logout`,
		{ method: "POST" },
		nativeAccountLogoutResponseSchema
	);
}
