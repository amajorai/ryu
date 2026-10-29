import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { type ApiTarget, request } from "./client.ts";

export type ConversationAccessRole = "participant" | "viewer";
export type ConversationVisibility = "org" | "private" | "team";

export interface ConversationCollaborator {
	role: ConversationAccessRole;
	user_id: string;
}

export interface ConversationAccess {
	can_manage: boolean;
	collaborators: ConversationCollaborator[];
	owner_user_id: string | null;
	team_id: string | null;
	visibility: ConversationVisibility;
}

export interface PrincipalDirectory {
	members: Array<{ email: string | null; id: string; name: string }>;
	org_id?: string | null;
	teams: Array<{ id: string; name: string }>;
}

export interface PublicShareStatus {
	created_at: number;
	updated_at: number;
	url: string;
}

export interface PublicSnapshotMessage {
	content: string;
	created_at: number;
	id: string;
	role: "assistant" | "user";
}

interface CoreConversationDetail {
	messages?: Array<{
		content?: unknown;
		created_at?: unknown;
		id?: unknown;
		role?: unknown;
	}>;
}

interface PublicShareResponse {
	share: PublicShareStatus | null;
}

function activeBearer(): string {
	const token = getActiveToken();
	if (!token) {
		throw new Error("Sign in to publish a public link.");
	}
	return token;
}

async function controlPlaneRequest<T>(
	path: string,
	schema: z.ZodType<T>,
	options: { body?: unknown; method?: string } = {}
): Promise<T> {
	const response = await fetch(`${BACKEND_URL}${path}`, {
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		headers: {
			Authorization: `Bearer ${activeBearer()}`,
			"Content-Type": "application/json",
		},
		method: options.method ?? "GET",
		signal: AbortSignal.timeout(15_000),
	});
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const parsed = z.object({ message: z.string() }).safeParse(body);
		const message = parsed.success
			? parsed.data.message
			: `Sharing request failed (${response.status})`;
		throw new Error(message);
	}
	return schema.parse(body);
}

export function getConversationAccess(
	target: ApiTarget,
	conversationId: string
): Promise<ConversationAccess> {
	return request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/access`,
		undefined,
		conversationAccessResponseCodec
	);
}

export function setConversationAccess(
	target: ApiTarget,
	conversationId: string,
	access: Pick<ConversationAccess, "collaborators" | "team_id" | "visibility">
): Promise<ConversationAccess & { ok: boolean }> {
	return request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/access`,
		{ method: "PUT", body: access },
		responseCodec1
	);
}

export function getPrincipalDirectory(
	target: ApiTarget
): Promise<PrincipalDirectory> {
	return request(
		target,
		"/api/acl/principals",
		undefined,
		principalDirectoryResponseCodec
	);
}

/** Read a fresh, full transcript and reduce it to the public snapshot schema. */
export async function getPublicSnapshotMessages(
	target: ApiTarget,
	conversationId: string
): Promise<PublicSnapshotMessage[]> {
	const detail = await request<CoreConversationDetail>(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}`,
		undefined,
		coreConversationDetailResponseCodec
	);
	return (detail.messages ?? [])
		.flatMap((message): PublicSnapshotMessage[] => {
			if (
				(message.role !== "user" && message.role !== "assistant") ||
				!isNativeText(message.id) ||
				!isNativeText(message.content) ||
				!isNativeNumber(message.created_at)
			) {
				return [];
			}
			return [
				{
					content: message.content,
					created_at: message.created_at,
					id: message.id,
					role: message.role,
				},
			];
		})
		.slice(-500);
}

const publicShareResponseSchema = z.object({
	share: z
		.object({ created_at: z.number(), updated_at: z.number(), url: z.string() })
		.nullable(),
});

export async function getPublicShare(
	conversationId: string
): Promise<PublicShareStatus | null> {
	const response = await controlPlaneRequest<PublicShareResponse>(
		`/api/conversation-shares/conversation/${encodeURIComponent(conversationId)}`,
		publicShareResponseSchema
	);
	return response.share;
}

export async function publishPublicShare(
	conversationId: string,
	title: string,
	messages: PublicSnapshotMessage[]
): Promise<PublicShareStatus> {
	const response = await controlPlaneRequest<PublicShareResponse>(
		`/api/conversation-shares/conversation/${encodeURIComponent(conversationId)}`,
		publicShareResponseSchema,
		{ body: { messages, title }, method: "PUT" }
	);
	if (!response.share) {
		throw new Error("The share link was not returned.");
	}
	return response.share;
}

/**
 * Revokes a public link for a conversation. Pass `ownerUserId` to name whose
 * copy to revoke: the signed-in user's own id revokes only their link and never
 * falls through to the organization-admin path, which refuses to pick one of
 * several members' copies.
 */
export async function revokePublicShare(
	conversationId: string,
	ownerUserId?: string
): Promise<void> {
	const query = ownerUserId
		? `?${new URLSearchParams({ owner_user_id: ownerUserId }).toString()}`
		: "";
	await controlPlaneRequest<{ ok: boolean }>(
		`/api/conversation-shares/conversation/${encodeURIComponent(conversationId)}${query}`,
		z.object({ ok: z.boolean() }),
		{ method: "DELETE" }
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const conversationAccessRoleResponseCodec = z.union([
	z.literal("participant"),
	z.literal("viewer"),
]);
const conversationCollaboratorResponseCodec = z
	.object({ role: conversationAccessRoleResponseCodec, user_id: z.string() })
	.catchall(gatewayJsonValueSchema);
const conversationVisibilityResponseCodec = z.union([
	z.literal("org"),
	z.literal("private"),
	z.literal("team"),
]);
const conversationAccessResponseCodec = z
	.object({
		can_manage: z.boolean(),
		collaborators: z.array(conversationCollaboratorResponseCodec),
		owner_user_id: z.union([z.string(), z.null()]),
		team_id: z.union([z.string(), z.null()]),
		visibility: conversationVisibilityResponseCodec,
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z.intersection(
	conversationAccessResponseCodec,
	z.object({ ok: z.boolean() }).catchall(gatewayJsonValueSchema)
);
const principalDirectoryResponseCodec = z
	.object({
		members: z.array(
			z
				.object({
					email: z.union([z.string(), z.null()]),
					id: z.string(),
					name: z.string(),
				})
				.catchall(gatewayJsonValueSchema)
		),
		org_id: z.union([z.string(), z.null()]).optional(),
		teams: z.array(
			z
				.object({ id: z.string(), name: z.string() })
				.catchall(gatewayJsonValueSchema)
		),
	})
	.catchall(gatewayJsonValueSchema);
const coreConversationDetailResponseCodec = z
	.object({
		messages: z
			.array(
				z
					.object({
						content: gatewayJsonValueSchema.optional(),
						created_at: gatewayJsonValueSchema.optional(),
						id: gatewayJsonValueSchema.optional(),
						role: gatewayJsonValueSchema.optional(),
					})
					.catchall(gatewayJsonValueSchema)
			)
			.optional(),
	})
	.catchall(gatewayJsonValueSchema);
