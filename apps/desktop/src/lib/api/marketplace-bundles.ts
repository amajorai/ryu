import type { MarketplaceBundleMember } from "@ryu/marketplace/catalog/bundle-types";
import { z } from "zod";
import { installPublishedAgent } from "./agents.ts";
import { type ApiTarget, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import {
	installPortablePackage,
	recordMarketplaceUsage,
} from "./marketplace.ts";
import type { MarketplaceBundleMemberInput } from "./marketplace-bundle-contracts.ts";
import { installMcpServer } from "./mcp.ts";
import { installModelFile } from "./models.ts";
import { installApp, installPluginFromCatalog } from "./plugins.ts";
import { installSkill } from "./skills.ts";
import { installWorkflowTemplate } from "./workflows.ts";

export interface MarketplaceBundleProgress<
	T extends MarketplaceBundleMemberInput = MarketplaceBundleMember,
> {
	completed: number;
	member: T;
	total: number;
}

export interface MarketplaceBundleFailure<
	T extends MarketplaceBundleMemberInput = MarketplaceBundleMember,
> {
	error: string;
	member: T;
}

/** A member the bundle cannot install unattended. It is neither a failure nor
 * a success: the user finishes it from the member's own catalog page. */
export interface MarketplaceBundleManualStep<
	T extends MarketplaceBundleMemberInput = MarketplaceBundleMember,
> {
	member: T;
	reason: string;
}

export interface MarketplaceBundleInstallResult<
	T extends MarketplaceBundleMemberInput = MarketplaceBundleMember,
> {
	completed: T[];
	failures: MarketplaceBundleFailure<T>[];
	manual: MarketplaceBundleManualStep<T>[];
	skipped: T[];
}

/** Thrown by a member installer when the member needs a user decision. */
class BundleManualStep extends Error {}

/** A model member's `source` may name the exact GGUF file to download. Any
 * other value (or none) leaves the quantization choice to the user. */
function modelFileFromSource(source: string | null | undefined): string | null {
	const file = source?.trim() ?? "";
	if (!file.toLowerCase().endsWith(".gguf") || file.includes("..")) {
		return null;
	}
	return file;
}

/** Human-facing summary of manual steps, for toasts and dialogs. */
export function describeBundleManualSteps<
	T extends MarketplaceBundleMemberInput,
>(manual: MarketplaceBundleManualStep<T>[]): string | null {
	const first = manual[0];
	if (!first) {
		return null;
	}
	const more = manual.length > 1 ? ` (+${manual.length - 1} more)` : "";
	return `${manual.length} need manual setup: ${first.member.name ?? first.member.id}: ${first.reason}${more}`;
}

function errorMessage<TCause>(cause: TCause): string {
	return cause instanceof Error ? cause.message : String(cause);
}

const callableUuidSchema = z.function();
// Exceptions may be Error instances, plain HTTP records, or arrays with a status.
const exceptionObjectSchema = z.custom<object>((value) => {
	const owner = new Object(value);
	return value === owner && !callableUuidSchema.safeParse(value).success;
});
const conflictResponseSchema = exceptionObjectSchema.check(
	z.property("status", z.literal(409))
);

function isAlreadyInstalled<TCause>(cause: TCause): boolean {
	if (conflictResponseSchema.safeParse(cause).success) {
		return true;
	}
	return /already installed|already exists|already active|duplicate/i.test(
		errorMessage(cause)
	);
}

const knowledgeInstallResponseSchema = z
	.object({
		error: z.string().optional(),
		success: z.boolean().optional(),
	})
	.passthrough();

/** Install a knowledge bundle through Core's catalog install route, which
 * resolves and verifies it through the active knowledge source. */
async function installKnowledgeBundle(
	target: ApiTarget,
	id: string
): Promise<void> {
	const json = await request(
		target,
		"/api/knowledge/catalog/install",
		{ method: "POST", body: { id } },
		knowledgeInstallResponseSchema
	);
	if (json?.success === false) {
		throw new Error(json.error ?? `Failed to install ${id}`);
	}
}

async function installMember(
	target: ApiTarget,
	member: MarketplaceBundleMemberInput
): Promise<void> {
	switch (member.kind) {
		case "app":
			await installApp(target, member.id);
			return;
		case "plugin":
			await installPluginFromCatalog(target, member.id);
			return;
		case "skill":
			await installSkill(target, member.id, member.source ?? undefined);
			return;
		case "agent":
			await installPublishedAgent(
				target,
				member.id,
				callableUuidSchema.safeParse(globalThis.crypto?.randomUUID).success
					? globalThis.crypto.randomUUID()
					: `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`
			);
			return;
		case "mcp":
			await installMcpServer(target, member.id);
			return;
		case "workflow":
		case "stack_template":
			await installWorkflowTemplate(target, member.id);
			return;
		case "theme":
		case "language_pack":
		case "output_style":
		case "space":
		case "profile":
			await installPortablePackage(target, {
				kind: member.kind,
				id: member.id,
			});
			return;
		case "knowledge":
			await installKnowledgeBundle(target, member.id);
			return;
		case "model": {
			const file = modelFileFromSource(member.source);
			if (!file) {
				throw new BundleManualStep(
					"choose a model file in Models, then install it there."
				);
			}
			await installModelFile(target, member.id, file);
			return;
		}
		default: {
			const unsupported: never = member.kind;
			throw new Error(`Unsupported bundle member kind: ${unsupported}`);
		}
	}
}

/**
 * Install a bundle through the existing per-kind authorities. This function only
 * orchestrates: Core still validates app/plugin/skill/agent/workflow/MCP installs,
 * and a failed optional member is reported instead of being presented as success.
 * Members are sequential so a user can see exactly where a bundle stopped and
 * retries do not create a burst of competing lifecycle writes.
 */
export async function installMarketplaceBundle<
	T extends MarketplaceBundleMemberInput,
>(
	target: ApiTarget,
	bundleId: string,
	members: T[],
	onProgress?: (progress: MarketplaceBundleProgress<T>) => void
): Promise<MarketplaceBundleInstallResult<T>> {
	// Await preparation before member writes. Failure remains best effort; every
	// member's install endpoint still enforces its own authorization and result.
	await request(
		target,
		"/api/marketplace/public-catalog",
		{
			method: "POST",
			body: { kind: "bundle" },
		},
		gatewayJsonValueSchema
	).catch(() => undefined);
	const result: MarketplaceBundleInstallResult<T> = {
		completed: [],
		failures: [],
		manual: [],
		skipped: [],
	};
	const boundedMembers = members.slice(0, 64);
	for (const [index, member] of boundedMembers.entries()) {
		onProgress?.({
			completed: index,
			member,
			total: boundedMembers.length,
		});
		try {
			await installMember(target, member);
			result.completed.push(member);
		} catch (cause) {
			if (cause instanceof BundleManualStep) {
				result.manual.push({ member, reason: cause.message });
			} else if (isAlreadyInstalled(cause)) {
				result.skipped.push(member);
			} else {
				result.failures.push({ error: errorMessage(cause), member });
			}
		}
		onProgress?.({
			completed: index + 1,
			member,
			total: boundedMembers.length,
		});
	}
	await recordMarketplaceUsage(target, {
		event: "download",
		id: bundleId,
		kind: "bundle",
	}).catch(() => undefined);
	return result;
}
