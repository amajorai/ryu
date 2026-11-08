// Credit-ledger task labels, in the reader's language.
//
// A ledger row's `taskLabel` is free text. Users and agents name their own
// tasks there, and those names stay exactly as written. The platform's own
// producers also write English labels into the same field: Connect receipts
// (`packages/api/src/lib/service-usage-settlement-receipts.ts`), metered
// service windows (`service-usage-settlement-shared.ts` `windowLabel`),
// messaging and phone-number leases, mail overage, Box and Managed Agents
// slugs, Gateway tool, media and web debits, and Core's Treg and Composio
// charges. `localizeUsageTaskLabel` recognises those templates with anchored
// patterns and renders them through `tl()`, so the usage table, the desktop
// Usage ledger and interface snapshots show them in the reader's language,
// with the metered window as a locale date range. Anything it does not
// recognise is returned unchanged.
//
// When a producer adds or changes a template, update it here: the guard test
// in `usage-task-label-producers.test.ts` fails until it is.

import { activeLocale, directionForLocale } from "@ryu/i18n/core";
import { isolateLtr } from "@ryu/i18n/format-bidi";
import { dateFormatter } from "@ryu/i18n/format-intl";

/** Any `tl()`-shaped translator: `useLiteralMessages()`, `translate`, … */
export type UsageTaskTranslator = (
	source: string,
	values?: Record<string, string | number>
) => string;

type Localize = (
	match: RegExpExecArray,
	tl: UsageTaskTranslator,
	locale: string
) => string | null;

interface TaskLabelPattern {
	localize: Localize;
	pattern: RegExp;
}

const WINDOW_FORMAT: Intl.DateTimeFormatOptions = {
	dateStyle: "medium",
	timeStyle: "short",
};

/** The metered window as one locale date range, or null for a bad timestamp. */
export function usageWindowRange(
	start: string,
	end: string,
	locale: string
): string | null {
	const from = new Date(start);
	const to = new Date(end);
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
		return null;
	}
	const format = dateFormatter(locale, WINDOW_FORMAT);
	return typeof format.formatRange === "function"
		? format.formatRange(from, to)
		: `${format.format(from)} – ${format.format(to)}`;
}

/** One hosted service's hourly window (`SERVICE_USAGE_SERVICES`). */
function serviceWindow(
	service: string,
	window: string,
	tl: UsageTaskTranslator
): string | null {
	switch (service) {
		case "box":
			return tl("Box usage, {window}", { window });
		case "connect":
			return tl("Connect usage, {window}", { window });
		case "notify":
			return tl("Notify usage, {window}", { window });
		case "passport":
			return tl("Passport usage, {window}", { window });
		default:
			return null;
	}
}

function literalLabel(label: string, tl: UsageTaskTranslator): string | null {
	switch (label) {
		case "1 composio tool call (Connect)":
			return tl("1 Composio tool call (Connect)");
		case "box-storage":
			return tl("Box storage");
		case "box-reconcile":
			return tl("Box usage reconciliation");
		case "web_search":
			return tl("Web search");
		case "web_fetch":
			return tl("Web fetch");
		case "Delivered Composio trigger event":
			return tl("Delivered Composio trigger event");
		case "Outpost X post":
			return tl("Outpost X post");
		case "Plan credits taken back after a refund":
			return tl("Plan credits taken back after a refund");
		case "Plan credits taken back after a refund (complete)":
			return tl("Plan credits taken back after a refund (complete)");
		case "Plan credits taken back after a refund (rest still owed)":
			return tl("Plan credits taken back after a refund (rest still owed)");
		default:
			return null;
	}
}

/** Gateway media modalities (`Modality::as_str`), labelled. */
function modalityLabel(
	modality: string,
	tl: UsageTaskTranslator
): string | null {
	switch (modality) {
		case "chat":
			return tl("Chat");
		case "image":
			return tl("Image generation");
		case "tts":
			return tl("Text to speech");
		case "stt":
			return tl("Speech to text");
		case "video":
			return tl("Video generation");
		case "audio":
			return tl("Audio generation");
		default:
			return null;
	}
}

/**
 * The masked number a messaging label names (`+1…42`, laid out left to right
 * in an RTL sentence), or the producer's English stand-in for a number it
 * could not mask, translated.
 */
function partyLabel(
	party: string,
	tl: UsageTaskTranslator,
	locale: string
): string {
	if (party === "a recipient") {
		return tl("a recipient");
	}
	return party.startsWith("+") && directionForLocale(locale) === "rtl"
		? isolateLtr(party)
		: party;
}

function inboundMessage(
	channel: string,
	party: string,
	tl: UsageTaskTranslator
): string | null {
	switch (channel) {
		case "SMS":
			return tl("Inbound SMS from {party}", { party });
		case "MMS":
			return tl("Inbound MMS from {party}", { party });
		case "WhatsApp":
			return tl("Inbound WhatsApp message from {party}", { party });
		case "Voice message":
			return tl("Inbound voice message from {party}", { party });
		default:
			return null;
	}
}

function outboundMessage(
	channel: string,
	party: string,
	tl: UsageTaskTranslator
): string | null {
	switch (channel) {
		case "SMS":
			return tl("SMS to {party}", { party });
		case "MMS":
			return tl("MMS to {party}", { party });
		case "WhatsApp":
			return tl("WhatsApp message to {party}", { party });
		case "Voice message":
			return tl("Voice message to {party}", { party });
		default:
			return null;
	}
}

const CHANNEL = "(SMS|MMS|WhatsApp|Voice message)";
const NUMBER = "(\\d+)";

/** Matched in order; every pattern is anchored at both ends. */
const PATTERNS: readonly TaskLabelPattern[] = [
	{
		localize: ([, tool = "", version = ""], tl) =>
			tl("1 run of composed tool {tool} v{version} (maker fee, Connect)", {
				tool,
				version,
			}),
		pattern: /^1 run of composed tool (.+) v(\S+) \(maker fee, Connect\)$/u,
	},
	{
		localize: ([, endpoint = ""], tl) =>
			tl("1 {endpoint} call on Ryu's key (Connect)", { endpoint }),
		pattern: /^1 (.+) call on Ryu's key \(Connect\)$/u,
	},
	{
		localize: ([, toolkit = ""], tl) =>
			tl("1 native {toolkit} tool call (Connect)", { toolkit }),
		pattern: /^1 native (.+) tool call \(Connect\)$/u,
	},
	{
		localize: ([, service = "", start = "", end = ""], tl, locale) => {
			const window = usageWindowRange(start, end, locale);
			return window ? serviceWindow(service, window, tl) : null;
		},
		pattern: /^(box|notify|passport|connect) usage (\S+)–(\S+)$/u,
	},
	{
		localize: ([, channel = "", party = ""], tl, locale) =>
			inboundMessage(channel, partyLabel(party, tl, locale), tl),
		pattern: new RegExp(`^Inbound ${CHANNEL} from (.+)$`, "u"),
	},
	{
		localize: ([, party = "", parts = ""], tl, locale) =>
			tl("SMS to {party} ({count, plural, one {# part} other {# parts}})", {
				count: Number(parts),
				party: partyLabel(party, tl, locale),
			}),
		pattern: new RegExp(`^SMS to (.+) \\(${NUMBER} parts\\)$`, "u"),
	},
	{
		localize: ([, channel = "", party = ""], tl, locale) =>
			outboundMessage(channel, partyLabel(party, tl, locale), tl),
		pattern: new RegExp(`^${CHANNEL} to (.+)$`, "u"),
	},
	{
		localize: ([, which = "", period = ""], tl, locale) =>
			tl("Phone number lease {which} (period {period})", {
				period: Number(period),
				which: partyLabel(which, tl, locale),
			}),
		pattern: new RegExp(
			`^Phone number lease (.+) \\(period ${NUMBER}\\)$`,
			"u"
		),
	},
	{
		localize: ([, count = ""], tl) =>
			tl(
				"Mail overage: {count, plural, one {# recipient} other {# recipients}}",
				{ count: Number(count) }
			),
		pattern: new RegExp(`^Mail overage: ${NUMBER} recipients$`, "u"),
	},
	{
		localize: ([, count = "", provider = ""], tl) =>
			tl(
				"{count, plural, one {# {provider} tool call} other {# {provider} tool calls}}",
				{ count: Number(count), provider }
			),
		pattern: new RegExp(`^${NUMBER} (\\S+) tool calls?$`, "u"),
	},
	{
		localize: ([, slug = ""], tl) =>
			tl("Composio {action} via Treg", { action: slug }),
		pattern: /^composio (\S+) via treg$/u,
	},
	{
		localize: ([, box = ""], tl) => tl("Box session {box}", { box }),
		pattern: /^box:(\S+)$/u,
	},
	{
		localize: ([, session = ""], tl) =>
			tl("Managed Agents session {session}", { session }),
		pattern: /^managed-agents:(\S+)$/u,
	},
	{
		localize: ([, modality = ""], tl) => {
			const label = modalityLabel(modality, tl);
			return label ? tl("{label} (estimated cost)", { label }) : null;
		},
		pattern: /^(\w+) \(estimated cost\)$/u,
	},
	{
		localize: ([, modality = ""], tl) => modalityLabel(modality, tl),
		pattern: /^(chat|image|tts|stt|video|audio)$/u,
	},
];

/**
 * `label` in the reader's language when it is one of the platform's own
 * ledger templates; otherwise (a user or agent task name) unchanged.
 */
export function localizeUsageTaskLabel(
	label: string,
	tl: UsageTaskTranslator,
	locale: string = activeLocale()
): string {
	const literal = literalLabel(label, tl);
	if (literal !== null) {
		return literal;
	}
	for (const { localize, pattern } of PATTERNS) {
		const match = pattern.exec(label);
		if (match) {
			return localize(match, tl, locale) ?? label;
		}
	}
	return label;
}
