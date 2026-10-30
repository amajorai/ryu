import {
	BrainIcon,
	BrowserIcon,
	CheckmarkBadge02Icon,
	CursorMagicSelection04Icon,
	File01Icon,
	FileSearchIcon,
	GlobeIcon,
	Layers01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CapabilityLayerEntry } from "@/src/hooks/useCapabilityLayers.ts";
import type { CapabilityProvider } from "@/src/lib/api/capability-layers.ts";

/** The capability layers whose ICON and DISPLAY ORDER this client knows.
 *
 *  A "layer" here is a CAPABILITY (`web.search`, `browser.control`, …) that
 *  several enabled apps can provide at once; picking a row pins the capability to
 *  that app, exactly like swapping Chat pins the resident runtime.
 *
 *  It carries NO label. The layer's name comes from the capability's own
 *  providers now (`ProvidesEntry.title` → Core's `CapabilityInfo.title` →
 *  {@link CapabilityLayerEntry.title}), because a closed label table on the client
 *  can only ever name the layers that shipped with it — everything else fell
 *  through to the raw dotted id, and the dropdown read `document.parse` next to
 *  five English words.
 *
 *  Icon and order stay here because neither is plumbable through a manifest: a
 *  hugeicons `IconSvgElement` is a module import, not a string, and "which layer
 *  comes first" is a property of this menu, not of any one app. A capability with
 *  no row still renders — generic icon, after the known ones — so a third-party
 *  toolkit is never hidden by this list.
 *
 *  `fallbackLabel` is degradation only: it names the layer when Core reports no
 *  title, which today means an older Core that predates the field. Adding a row
 *  here is NOT how a new layer gets named — declare `title` on its providers. */
const CAPABILITY_LAYERS: Array<{
	capability: string;
	fallbackLabel: string;
	icon: IconSvgElement;
}> = [
	{ capability: "web.search", fallbackLabel: "Search", icon: Search01Icon },
	{ capability: "web.extract", fallbackLabel: "Extract", icon: FileSearchIcon },
	{ capability: "web.crawl", fallbackLabel: "Crawl", icon: GlobeIcon },
	{
		capability: "browser.control",
		fallbackLabel: "Browser",
		icon: BrowserIcon,
	},
	{
		capability: "computer.control",
		fallbackLabel: "Device",
		icon: CursorMagicSelection04Icon,
	},
	{ capability: "memory", fallbackLabel: "Memory", icon: BrainIcon },
	// Route-backed, not verb-backed (see `providerDetail`) — it is a layer like any
	// other and gets an icon and a place in the order for the same reasons.
	{
		capability: "document.parse",
		fallbackLabel: "Document Parsing",
		icon: File01Icon,
	},
	{
		capability: "verify.claim",
		fallbackLabel: "Verification",
		icon: CheckmarkBadge02Icon,
	},
];

/** Splits a capability's last segment on the separators an id may use. */
const CAPABILITY_WORD_SPLIT = /[_-]+/;

/** How long a layer label may be before it is clipped. App-supplied text sits in a
 *  `shrink-0` slot in the dropdown row, so an unbounded one stretches the whole
 *  menu; long enough for every real name, short enough that no manifest can. */
const MAX_LAYER_LABEL = 28;

/** Title-cased last segment of a dotted capability id (`acme.pdf_parse` →
 *  `Pdf Parse`).
 *
 *  The bottom rung of the label ladder, and the reason no row can ever show a
 *  machine name: an undeclared capability reads as words rather than as
 *  `acme.pdf_parse`. Deliberately NOT applied server-side — humanising the whole
 *  id there would have printed `News Crud` for an app's private wiring, and the
 *  right answer for those is a title their author chose or none at all. */
function humanizeCapability(capability: string): string {
	const last = capability.split(".").pop() ?? capability;
	const words = last.split(CAPABILITY_WORD_SPLIT).filter(Boolean);
	if (words.length === 0) {
		return capability;
	}
	return words
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** The label ladder for one layer: what its providers call it, else what this
 *  client knows it as, else its own id read as words. Clipped because the first
 *  rung is text an app wrote. */
export function capabilityLabel(
	entry: CapabilityLayerEntry,
	fallbackLabel?: string
): string {
	const label =
		entry.title ?? fallbackLabel ?? humanizeCapability(entry.capability);
	return label.length > MAX_LAYER_LABEL
		? `${label.slice(0, MAX_LAYER_LABEL - 1)}…`
		: label;
}

interface CapabilityLayerRow {
	entry: CapabilityLayerEntry;
	icon: IconSvgElement;
	label: string;
}

/** Known layers first in table order, then anything else Core reported. */
export function orderCapabilityLayers(
	layers: CapabilityLayerEntry[]
): CapabilityLayerRow[] {
	const remaining = new Map(layers.map((layer) => [layer.capability, layer]));
	const rows: CapabilityLayerRow[] = [];
	for (const known of CAPABILITY_LAYERS) {
		const entry = remaining.get(known.capability);
		if (entry) {
			remaining.delete(known.capability);
			rows.push({
				entry,
				icon: known.icon,
				label: capabilityLabel(entry, known.fallbackLabel),
			});
		}
	}
	for (const entry of remaining.values()) {
		rows.push({
			entry,
			icon: Layers01Icon,
			label: capabilityLabel(entry),
		});
	}
	return rows;
}

/**
 * `This device` / `Remote desktop` — which machine a provider acts on.
 *
 * Returned only when the capability's providers actually DISAGREE. Labelling
 * every row when they all drive the same machine is noise that trains the user to
 * ignore the label, which is exactly when it stops working for the one layer
 * (`computer.control`) where the difference is real.
 */
function providerTargetLabel(
	provider: CapabilityProvider,
	siblings: CapabilityProvider[]
): string | null {
	if (!provider.target) {
		return null;
	}
	const distinct = new Set(siblings.map((p) => p.target ?? "unknown"));
	if (distinct.size < 2) {
		return null;
	}
	return provider.target === "local-machine" ? "this device" : "remote desktop";
}

/**
 * `3 verbs` / `default · 3 verbs` — what this provider actually exposes.
 *
 * The verb count is stated only by providers that HAVE verbs. A route-backed
 * provider is served by Core calling its sidecar directly, so it has none by
 * design — `document.parse`'s five parsers all declare zero — and counting them
 * printed "no verbs" on five working backends. An empty detail renders as no detail
 * line at all (`NodeLayerMenu` skips falsy), which is the honest answer when the row
 * has nothing to add beyond its name.
 *
 * No branch for a provider that serves nothing at all: that row is `disabled`, and
 * `NodeLayerMenu` renders `disabledReason` in place of the detail, so anything
 * returned here for it could never appear on screen.
 */
export function providerDetail(
	provider: CapabilityProvider,
	siblings: CapabilityProvider[]
): string {
	const parts: string[] = [];
	if (provider.servesVerbs) {
		const count = provider.verbs.length;
		parts.push(`${count} verb${count === 1 ? "" : "s"}`);
	}
	if (provider.isDefault) {
		parts.unshift("default");
	}
	// Leads the detail line: which device this types on outranks how many verbs
	// it exposes when the two candidates are not the same machine.
	const where = providerTargetLabel(provider, siblings);
	if (where) {
		parts.unshift(where);
	}
	return parts.join(" · ");
}

/** "Pinned · 2 providers enabled" — where the current pick came from. */
export function layerCaption(entry: CapabilityLayerEntry): string {
	if (!entry.boundProvider) {
		return "No provider bound";
	}
	const count = entry.providers.length;
	const origin = entry.overridden ? "Pinned" : "Auto-picked";
	const base = `${origin} · ${count} provider${count === 1 ? "" : "s"} enabled`;
	// When the candidates drive DIFFERENT machines, the caption is the only thing
	// visible without opening the submenu — and "2 providers enabled" alone reads
	// as "two ways to do the same thing", which is the misreading this exists to
	// prevent. Name what the bound one actually acts on.
	const where = providerTargetLabel(entry.boundProvider, entry.providers);
	return where ? `${base} · ${where}` : base;
}
