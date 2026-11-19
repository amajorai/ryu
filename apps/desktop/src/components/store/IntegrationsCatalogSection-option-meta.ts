import type { LiteralMessage } from "@ryu/i18n/react";
import type { IntegrationOption } from "@/src/lib/api/integrations.ts";
import { providerOptionPrice } from "@/src/lib/integration-price.ts";
import {
	providerOptionKind,
	SOURCE_LABELS,
} from "./IntegrationsCatalogSection-options.ts";

/** The source chip, translated (brand names such as Composio and Treg stay). */
function sourceLabel(source: string, tl: LiteralMessage): string {
	switch (source) {
		case "directory":
			return tl("Directory");
		case "ryu":
			return tl("Ryu catalog");
		default:
			return SOURCE_LABELS.get(source) ?? source;
	}
}

/**
 * The kind label, translated. `providerOptionKind` stays English because the
 * install-chat prompt (a model instruction) reads it too. Acronym kinds
 * (MCP, CLI, GraphQL, REST) pass through.
 */
function kindLabel(option: IntegrationOption, tl: LiteralMessage): string {
	switch (option.kind) {
		case "composio-toolkit":
			return tl("Toolkit");
		case "treg-platform":
		case "ryu-platform":
			return tl("Platform catalog");
		case "treg-endpoint":
			return tl("Treg endpoint");
		case "ryu-endpoint":
			return tl("Ryu endpoint");
		default: {
			const kind = providerOptionKind(option);
			return kind === "REST API" ? tl("REST API") : kind;
		}
	}
}

/**
 * The muted meta line under a provider option, one translated part each. The
 * row renders every part as its own text node, so a part is never glued to its
 * neighbours with " · " into one string the catalog cannot match.
 */
export function providerOptionMetaParts(
	option: IntegrationOption,
	tl: LiteralMessage
): string[] {
	return [
		sourceLabel(option.source, tl),
		kindLabel(option, tl),
		option.providerRole === "alternative" ? tl("Alternative") : null,
		option.provider,
		option.capability,
		providerOptionPrice(option.price),
		option.availabilityNote,
	].filter((part): part is string => Boolean(part));
}
