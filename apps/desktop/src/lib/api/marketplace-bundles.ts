import type { MarketplaceBundleMember } from "@ryu/marketplace/catalog/bundle-types";
import { installPublishedAgent } from "./agents.ts";
import type { ApiTarget } from "./client.ts";
import {
	installPortablePackage,
	recordMarketplaceUsage,
} from "./marketplace.ts";
import { installMcpServer } from "./mcp.ts";
import { installApp, installPluginFromCatalog } from "./plugins.ts";
import { installSkill } from "./skills.ts";
import { installWorkflowTemplate } from "./workflows.ts";

export interface MarketplaceBundleProgress {
	completed: number;
	member: MarketplaceBundleMember;
	total: number;
}

export interface MarketplaceBundleFailure {
	error: string;
	member: MarketplaceBundleMember;
}

export interface MarketplaceBundleInstallResult {
	completed: MarketplaceBundleMember[];
	failures: MarketplaceBundleFailure[];
	skipped: MarketplaceBundleMember[];
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isAlreadyInstalled(cause: unknown): boolean {
	if (
		cause &&
		typeof cause === "object" &&
		"status" in cause &&
		(cause as { status?: unknown }).status === 409
	) {
		return true;
	}
	return /already installed|already exists|already active|duplicate/i.test(
		errorMessage(cause)
	);
}

async function installMember(
	target: ApiTarget,
	member: MarketplaceBundleMember
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
				typeof globalThis.crypto?.randomUUID === "function"
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
		case "model":
			throw new Error(
				"Model members need a model file selection and cannot be installed from a bundle."
			);
	}
}

/**
 * Install a bundle through the existing per-kind authorities. This function only
 * orchestrates: Core still validates app/plugin/skill/agent/workflow/MCP installs,
 * and a failed optional member is reported instead of being presented as success.
 * Members are sequential so a user can see exactly where a bundle stopped and
 * retries do not create a burst of competing lifecycle writes.
 */
export async function installMarketplaceBundle(
	target: ApiTarget,
	bundleId: string,
	members: MarketplaceBundleMember[],
	onProgress?: (progress: MarketplaceBundleProgress) => void
): Promise<MarketplaceBundleInstallResult> {
	const result: MarketplaceBundleInstallResult = {
		completed: [],
		failures: [],
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
			if (isAlreadyInstalled(cause)) {
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
