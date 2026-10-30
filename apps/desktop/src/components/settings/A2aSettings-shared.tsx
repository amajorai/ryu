import type { LiteralMessage } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { ReactNode } from "react";
import { z } from "zod";
import type {
	A2aCardSignature,
	A2aPeerCredential,
	A2aScope,
	A2aTaskRecord,
} from "@/src/lib/api/a2a.ts";

export const ALL_SCOPES: A2aScope[] = [
	"send",
	"read",
	"cancel",
	"subscribe",
	"push_config",
	"extended_card",
];

export const CARD_SIGNATURE_LABELS: Record<A2aCardSignature["status"], string> =
	{
		invalid: "signature invalid",
		unsigned: "unsigned card",
		unverifiable: "signature unchecked",
		verified: "signed card",
	};

export function cardSignatureDetail(
	signature: A2aCardSignature,
	tl: LiteralMessage
): string {
	switch (signature.status) {
		case "verified":
			return tl("Agent Card signature verified with key {kid}", {
				kid: signature.kid,
			});
		case "unsigned":
			return "The peer's Agent Card carries no signature";
		case "unverifiable":
		case "invalid":
			return signature.reason;
		default:
			return "";
	}
}

export type PeerCredentialDraft =
	| { kind: "none" }
	| { kind: "bearer"; token: string }
	| { header: string; kind: "api_key"; value: string }
	| { kind: "basic"; password: string; username: string }
	| {
			clientId: string;
			clientSecret: string;
			kind: "oauth2_client_credentials";
			scopes: string;
			tokenUrl: string;
	  };

export function isPeerCredentialKind(
	value: string
): value is A2aPeerCredential["kind"] {
	return (
		value === "none" ||
		value === "bearer" ||
		value === "api_key" ||
		value === "basic" ||
		value === "oauth2_client_credentials"
	);
}

export function emptyCredentialDraft(
	kind: A2aPeerCredential["kind"]
): PeerCredentialDraft {
	switch (kind) {
		case "none":
			return { kind };
		case "bearer":
			return { kind, token: "" };
		case "api_key":
			return { header: "X-API-Key", kind, value: "" };
		case "basic":
			return { kind, password: "", username: "" };
		case "oauth2_client_credentials":
			return {
				clientId: "",
				clientSecret: "",
				kind,
				scopes: "",
				tokenUrl: "",
			};
		default: {
			const exhaustive: never = kind;
			return exhaustive;
		}
	}
}

export function credentialFromDraft(
	draft: PeerCredentialDraft
): A2aPeerCredential | undefined {
	switch (draft.kind) {
		case "none":
			return undefined;
		case "bearer":
			return draft.token.trim() ? draft : undefined;
		case "api_key":
			return draft.header.trim() && draft.value.trim() ? draft : undefined;
		case "basic":
			return draft.username.trim() && draft.password.trim() ? draft : undefined;
		case "oauth2_client_credentials":
			return draft.tokenUrl.trim() &&
				draft.clientId.trim() &&
				draft.clientSecret.trim()
				? {
						clientId: draft.clientId,
						clientSecret: draft.clientSecret,
						kind: draft.kind,
						scopes: draft.scopes
							.split(/[\s,]+/)
							.map((scope) => scope.trim())
							.filter(Boolean),
						tokenUrl: draft.tokenUrl,
					}
				: undefined;
		default: {
			const exhaustive: never = draft;
			return exhaustive;
		}
	}
}

export function errorMessage<TError>(error: TError): string {
	const parsed = z
		.object({ serverMessage: z.string().min(1) })
		.safeParse(error);
	if (parsed.success) {
		return parsed.data.serverMessage;
	}
	return error instanceof Error ? error.message : "The A2A request failed";
}

export function artifactSummaries(
	task: A2aTaskRecord
): { id: string; name: string }[] {
	const artifacts = task.protocolTask.artifacts;
	if (!Array.isArray(artifacts)) {
		return [];
	}
	const summaries: { id: string; name: string }[] = [];
	for (const artifact of artifacts) {
		const parsed = z
			.object({
				artifactId: z.string(),
				name: z.string().optional().catch(undefined),
			})
			.safeParse(artifact);
		if (!parsed.success) {
			continue;
		}
		const id = parsed.data.artifactId;
		const rawName = parsed.data.name;
		summaries.push({
			id,
			name: isNativeText(rawName) && rawName ? rawName : "Artifact",
		});
	}
	return summaries;
}

export function SectionCard({
	children,
	description,
	title,
}: {
	children: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<div className="space-y-4 rounded-lg bg-muted/40 p-4">
			<div>
				<h3 className="font-medium text-sm">{title}</h3>
				<p className="text-muted-foreground text-xs">{description}</p>
			</div>
			{children}
		</div>
	);
}
