// Display labels for a listing's "Extends" and "Where it lives" lists.
//
// The server (`packages/api/src/routers/marketplace.ts`), Core's catalog
// projection (`apps/core/src/catalog_source/manifest_surface.rs`) and the
// client fallback (`surface-summary.ts`) all emit the same English words as
// stable ids ("host-rendered views", "Shared Ryu shell", "tool runnable", …).
// The panel renders them through these helpers so each word becomes a whole
// translated message before the list is joined. Unknown words (capability ids,
// publisher-authored provider titles, future builder words) pass through.

import type { LiteralMessage } from "@ryu/i18n/react";

/** A runnable kind word in its own whole message ("tool runnable"). */
function runnableLabel(tl: LiteralMessage, kind: string): string {
	switch (kind.toLowerCase()) {
		case "agent":
			return tl("agent runnable");
		case "workflow":
			return tl("workflow runnable");
		case "tool":
			return tl("tool runnable");
		case "skill":
			return tl("skill runnable");
		case "companion":
			return tl("companion runnable");
		case "channel":
			return tl("channel runnable");
		case "engine":
			return tl("engine runnable");
		case "policy":
			return tl("policy runnable");
		default:
			return tl("{kind} runnable", { kind });
	}
}

/** Shell slot words: what a package adds to the shared Ryu shell. */
function shellFeatureLabel(tl: LiteralMessage, word: string): string | null {
	switch (word) {
		case "host-rendered views":
			return tl("host-rendered views");
		case "dock panels":
			return tl("dock panels");
		case "sidebar sections":
			return tl("sidebar sections");
		case "sidebar buttons":
			return tl("sidebar buttons");
		case "sidebar modes":
			return tl("sidebar modes");
		case "settings tabs":
			return tl("settings tabs");
		case "composer controls":
			return tl("composer controls");
		case "inline widgets":
			return tl("inline widgets");
		case "chat widget prompts":
			return tl("chat widget prompts");
		case "live activities":
			return tl("live activities");
		case "message actions":
			return tl("message actions");
		case "selection actions":
			return tl("selection actions");
		case "context-menu actions":
			return tl("context-menu actions");
		case "themes":
			return tl("themes");
		case "wallpaper backgrounds":
			return tl("wallpaper backgrounds");
		case "avatar accessories":
			return tl("avatar accessories");
		case "avatar styles":
			return tl("avatar styles");
		case "companion UI":
			return tl("companion UI");
		default:
			return null;
	}
}

/** Core runtime words: what Core runs or brokers for the package. */
function coreFeatureLabel(tl: LiteralMessage, word: string): string | null {
	switch (word) {
		case "turn hooks":
			return tl("turn hooks");
		case "app events":
			return tl("app events");
		case "tool filters":
			return tl("tool filters");
		case "activation events":
			return tl("activation events");
		case "MCP servers":
			return tl("MCP servers");
		case "MCP registration":
			return tl("MCP registration");
		case "capability broker":
			return tl("capability broker");
		case "capability and tool contract":
			return tl("capability and tool contract");
		case "managed process":
			return tl("managed process");
		default:
			return null;
	}
}

const RUNNABLE_WORD = /^(\S+) runnable$/u;
const PROCESS_WORD = /^(.+) process$/u;

/** One feature word as the reader's language shows it. */
export function implementationFeatureLabel(
	tl: LiteralMessage,
	feature: string
): string {
	const word = feature.trim();
	const known = shellFeatureLabel(tl, word) ?? coreFeatureLabel(tl, word);
	if (known !== null) {
		return known;
	}
	const runnable = RUNNABLE_WORD.exec(word);
	if (runnable?.[1]) {
		return runnableLabel(tl, runnable[1]);
	}
	const process = PROCESS_WORD.exec(word);
	if (process?.[1]) {
		return tl("{name} process", { name: process[1] });
	}
	return feature;
}

/** A group heading ("Shared Ryu shell", "Core runtime", "Browser", …). */
export function implementationGroupLabel(
	tl: LiteralMessage,
	label: string
): string {
	switch (label.trim()) {
		case "Browser":
			return tl("Browser");
		case "Computer":
			return tl("Computer");
		case "Web":
			return tl("Web");
		case "Document pipeline":
			return tl("Document pipeline");
		case "Core capability":
			return tl("Core capability");
		case "Shared Ryu shell":
			return tl("Shared Ryu shell");
		case "Core runtime":
			return tl("Core runtime");
		case "Package sidecar":
			return tl("Package sidecar");
		default:
			return label;
	}
}

/** The feature list line under a group heading, each word translated first. */
export function implementationFeatureLine(
	tl: LiteralMessage,
	features: readonly string[]
): string {
	return features
		.map((feature) => implementationFeatureLabel(tl, feature))
		.join(" · ");
}
