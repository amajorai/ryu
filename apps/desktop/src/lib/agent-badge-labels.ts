// apps/desktop/src/lib/agent-badge-labels.ts
//
// The agent Lanyard card's printed words in the UI language. The card is a
// canvas texture, so neither the DOM localizer nor the extractor reaches its
// text; this hook resolves each label through `tl()` and keeps the object
// stable while the resolved words stay the same, so the badge repaints only
// when the language (or a late-loading pack) changes what it says.

import { directionForLocale } from "@ryu/i18n/core";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { useRef } from "react";
import type { AgentBadgeLabels } from "./agent-badge.ts";

function sameLabels(a: AgentBadgeLabels, b: AgentBadgeLabels): boolean {
	return (Object.keys(a) as (keyof AgentBadgeLabels)[]).every(
		(key) => a[key] === b[key]
	);
}

export function useAgentBadgeLabels(): AgentBadgeLabels {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale ?? "en";
	const next: AgentBadgeLabels = {
		agent: tl("Agent"),
		coreStaff: tl("Core staff"),
		locale,
		newAgent: tl("New Agent"),
		onBehalf: tl(
			"Autonomous agent operating on behalf of the workspace above."
		),
		propertyOf: tl("Property of"),
		roleFallback: tl("Autonomous Agent"),
		rtl: directionForLocale(locale) === "rtl",
		serial: tl("Serial"),
		workspaceFallback: tl("Ryu Workspace"),
	};
	// `tl` is a fresh closure every render, so keep the previous object while
	// every word matches: callers key their paint effect on its identity.
	const stable = useRef(next);
	if (!sameLabels(stable.current, next)) {
		stable.current = next;
	}
	return stable.current;
}
