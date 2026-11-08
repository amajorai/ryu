/**
 * Display names for the Gateway pipeline stages, spoken in the slider's value text.
 *
 * `Stage.id` is the code id (`PipelineStage::as_str`, kebab-case) and must stay stable;
 * a reader hears this translated name instead, so no raw id reaches assistive tech.
 * Each name is a whole `tl` literal so the extractor sees it.
 */

import type { LiteralMessage } from "@ryu/i18n/react";

export function stageName(id: string, tl: LiteralMessage): string {
	switch (id) {
		case "rate-limit":
			return tl("Rate limit");
		case "firewall":
			return tl("Firewall");
		case "inspector":
			return tl("Inspector");
		case "inline-input":
			return tl("Input guardrails");
		case "policy":
			return tl("Policy");
		case "companion-dlp":
			return tl("Companion data loss prevention");
		case "route":
			return tl("Route");
		case "audit":
			return tl("Audit");
		default:
			return id;
	}
}
