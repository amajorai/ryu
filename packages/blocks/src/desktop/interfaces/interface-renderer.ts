import {
	activeLocale,
	dateFormatter,
	formatCompactAge,
	formatRelativeTime,
	translate as tr,
} from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	agentHandleText,
	type DeskView,
	type DeskViewSection,
	type InterfaceAgent,
	type InterfacePort,
	type InterfaceSnapshot,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";

/**
 * What every interface renderer receives. Renderers are pure presentation:
 * they read the snapshot, act through the port, and show the host's own
 * conversation surface (`threadView`) for the open thread, so streaming,
 * tools, and approvals behave the same in every interface.
 */
export interface InterfaceRendererProps<Params> {
	/** Id of the open thread, when the host knows it (null for a new thread). */
	activeThreadId: string | null;
	/** True until the host's first snapshot load settles. */
	loading: boolean;
	params: Params;
	port: InterfacePort;
	snapshot: InterfaceSnapshot;
	/** The host's canonical conversation surface, or null when none is open. */
	threadView: ReactNode | null;
}

export function agentById(
	snapshot: InterfaceSnapshot,
	agentId: string | null | undefined
): InterfaceAgent | undefined {
	return agentId
		? snapshot.agents.find((agent) => agent.id === agentId)
		: undefined;
}

/** Up to two initials for an avatar fallback. */
export function initials(name: string): string {
	const letters = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
	return letters || "?";
}

/** Stable hue for an id, so an agent keeps its color across interfaces. */
export function agentHue(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
	}
	return hash;
}

/**
 * List-badge age in the UI locale ("now", "5m", "3h", "2d" in English; "5分"
 * in Japanese). An unparsable time reads as an empty string.
 */
export function compactAge(
	iso: string,
	now: number = Date.now(),
	locale: string = activeLocale()
): string {
	if (Number.isNaN(Date.parse(iso))) {
		return "";
	}
	return formatCompactAge(locale, iso, { now });
}

/**
 * An age for "… ago" copy in the UI locale: "5m ago", "now" in English,
 * "5分前" in Japanese. A future time reads as now; an unparsable one is "".
 * Use this instead of wrapping `compactAge` in an "{age} ago" sentence.
 */
export function relativeAge(
	iso: string,
	now: number = Date.now(),
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	return formatRelativeTime(locale, Math.min(then, now), {
		now,
		style: "narrow",
	});
}

/**
 * A full date and time for a tooltip ("Oct 14, 2026, 3:05 PM" in English),
 * in the UI locale. An unparsable time reads as an empty string.
 */
export function fullTimestamp(
	iso: string,
	locale: string = activeLocale()
): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) {
		return "";
	}
	return dateFormatter(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(time));
}

const listFormatters = new Map<string, Intl.ListFormat>();

/**
 * Names joined as the UI locale lists them: "Ada and Grace", "Ada, Echo,
 * and Forge" in English; "Ada、Grace" in Japanese. Empty for no names.
 */
export function formatNameList(
	names: readonly string[],
	locale: string = activeLocale()
): string {
	let formatter = listFormatters.get(locale);
	if (!formatter) {
		try {
			formatter = new Intl.ListFormat(locale, { type: "conjunction" });
		} catch {
			formatter = new Intl.ListFormat("en", { type: "conjunction" });
		}
		listFormatters.set(locale, formatter);
	}
	return formatter.format(names);
}

/**
 * A thread status's label in the UI language (the protocol's
 * `THREAD_STATUS_LABELS`, translated), for copy that interpolates it.
 */
export function threadStatusLabel(
	status: ThreadStatus,
	tl: LiteralMessage = tr
): string {
	switch (status) {
		case "attention":
			return tl("Needs attention");
		case "quiet":
			return tl("Not started");
		case "waiting":
			return tl("Waiting on agent");
		case "working":
			return tl("Working");
		default:
			return tl("Your turn");
	}
}

/**
 * A desk view's label in the UI language. The protocol names the shared
 * views in English ("Needs you", "Pinned"); agent inboxes, teams and
 * projects keep their own names.
 */
export function deskViewLabel(view: DeskView, tl: LiteralMessage = tr): string {
	switch (view.kind) {
		case "all":
			return tl("All conversations");
		case "pinned":
			return tl("Pinned");
		case "status":
			if (view.id === "needs-you") {
				return tl("Needs you");
			}
			if (view.id === "working") {
				return tl("Working");
			}
			return view.id === "waiting" ? tl("Waiting on agent") : view.label;
		default:
			return view.label;
	}
}

/** A desk rail section's heading in the UI language. */
export function deskSectionLabel(
	id: DeskViewSection["id"],
	tl: LiteralMessage = tr
): string {
	switch (id) {
		case "groups":
			return tl("Teams & projects");
		case "inboxes":
			return tl("Agent inboxes");
		default:
			return tl("Views");
	}
}

/** The desk's sections with every built-in label in the UI language. */
export function localizeDeskSections(
	sections: readonly DeskViewSection[],
	tl: LiteralMessage = tr
): DeskViewSection[] {
	return sections.map((section) => ({
		...section,
		label: deskSectionLabel(section.id, tl),
		views: section.views.map((view) => ({
			...view,
			label: deskViewLabel(view, tl),
		})),
	}));
}

/**
 * `@handle` for an agent name. Built by the protocol's `agentHandleText`, so
 * `resolveAgentHandle` accepts every handle an interface shows or completes.
 */
export function agentHandle(name: string): string {
	return `@${agentHandleText(name)}`;
}
