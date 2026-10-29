import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { SECTION_PAGE_SIZE_KEY } from "./sidebar-panel-state.tsx";
import type { SectionKey } from "./sidebar-sections.ts";
import { parseSidebarPageSizes } from "./sidebar-state-contracts.ts";

// Per-section pagination: a section shows this many items before a "Show more"
// control reveals the next page. 0 means "All" (no cap). Sections default to 10
// items so the sidebar stays compact until the user opts into more (or All).
export const PAGE_SIZE_OPTIONS: { label: string; value: number }[] = [
	{ label: "5", value: 5 },
	{ label: "10", value: 10 },
	{ label: "15", value: 15 },
	{ label: "20", value: 20 },
	{ label: "50", value: 50 },
	{ label: "100", value: 100 },
	{ label: "All", value: 0 },
];
export const DEFAULT_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Scope pickers (the "Projects & Spaces as pickers" model)
// ---------------------------------------------------------------------------
// A section with twenty projects or a dozen spaces spent twenty or a dozen rows
// saying only which containers exist, before showing a single thing inside one. The
// picker inverts that: one row of chrome names the scope, and the whole section body
// is content. The default scope is deliberately "all" rather than the first
// container — the aggregate view is the one that answers "what did I touch
// recently", which is what a sidebar is scanned for.

/** The picker's default option: every container's contents at once. */
export const ALL_SELECTION = "all";

export const PROJECT_SELECTION_KEY = "ryu:sidebar-project-selection";
export const SPACE_VISIBILITY_ORDER_KEY = "ryu:sidebar-space-visibility-order";
export const SPACE_VISIBILITY_COLLAPSED_KEY =
	"ryu:sidebar-collapsed-space-visibility";

/** One picker option. `value` is the container's stable id (a folder path, a space
 *  id); {@link ALL_SELECTION} is reserved for the aggregate. */
interface ScopeOption {
	label: string;
	value: string;
}

/**
 * The picker's current selection, persisted per surface.
 *
 * Falls back to {@link ALL_SELECTION} whenever the stored value names a container
 * that no longer exists — a removed project or a deleted space. Without that the
 * section would render a correctly-empty list for something the user cannot see or
 * change, which reads as the sidebar being broken. The fallback is computed rather
 * than written back, so a container that reappears (a node reconnecting, a slow
 * spaces fetch) restores the user's choice instead of having silently lost it.
 */
export function usePickerSelection(
	storageKey: string,
	options: ScopeOption[]
): [string, (value: string) => void] {
	const [stored, setStored] = useState<string>(() => {
		try {
			return localStorage.getItem(storageKey) ?? ALL_SELECTION;
		} catch {
			return ALL_SELECTION;
		}
	});
	const choose = useCallback(
		(value: string) => {
			setStored(value);
			try {
				localStorage.setItem(storageKey, value);
			} catch {
				// best-effort
			}
		},
		[storageKey]
	);
	const known =
		stored === ALL_SELECTION || options.some((o) => o.value === stored);
	return [known ? stored : ALL_SELECTION, choose];
}

/** The picker itself: an "All …" default plus one option per container, sized and
 *  pitched to sit inside a sidebar section body rather than a settings form. */
export function SidebarScopePicker({
	actions,
	allLabel,
	icon,
	onValueChange,
	options,
	value,
}: {
	/**
	 * Verbs for the CURRENT selection, rendered beside the trigger.
	 *
	 * Load-bearing rather than decoration: replacing a row per container with one
	 * picker also removes the row each container's context menu hung off, and some
	 * of those verbs have no other home in the sidebar (activating a project, which
	 * is what the composer's cwd follows; uploading into a space). This slot is
	 * where they land, scoped to whatever the picker currently names.
	 */
	actions?: ReactNode;
	/** Copy for the aggregate option ("All projects" / "All spaces"). */
	allLabel: string;
	/** Usually the owning section's own glyph, so the picker reads as that
	 *  section's control rather than a stray form field. */
	icon?: IconSvgElement;
	onValueChange: (value: string) => void;
	options: ScopeOption[];
	value: string;
}) {
	const items = useMemo(
		() => [{ label: allLabel, value: ALL_SELECTION }, ...options],
		[allLabel, options]
	);
	return (
		<div className="mb-1 flex items-center gap-1 px-2">
			<Select
				items={items}
				// Base UI's change handler can hand back `null` (a cleared select). This
				// picker is never empty — clearing it means the aggregate view.
				onValueChange={(next) => onValueChange(next ?? ALL_SELECTION)}
				value={value}
			>
				<SelectTrigger
					className="min-w-0 flex-1"
					size="compact"
					variant="ghost"
				>
					<span className="flex min-w-0 items-center gap-2">
						{icon ? (
							<HugeiconsIcon
								className="size-3.5 shrink-0 text-muted-foreground"
								icon={icon}
							/>
						) : null}
						<SelectValue />
					</span>
				</SelectTrigger>
				<SelectContent className="max-h-[50vh]">
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{actions}
		</div>
	);
}

/** The `⋯` beside a scope picker. Mirrors {@link SectionOverflowMenu}'s trigger so
 *  it reads as the same affordance, but always visible rather than hover-revealed:
 *  the verbs behind it are the only path to some of them, so they cannot depend on
 *  the user discovering a hover target on a control they just used. */
export function ScopeMenu({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				activeHighlight
				aria-label={label}
				className="flex size-6 shrink-0 items-center justify-center"
				motion="color"
				variant="muted"
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56" sideOffset={6}>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function loadPageSizes() {
	try {
		const stored = localStorage.getItem(SECTION_PAGE_SIZE_KEY);
		return parseSidebarPageSizes(stored ? JSON.parse(stored) : null);
	} catch {
		return parseSidebarPageSizes(null);
	}
}

export function savePageSizes(sizes: Partial<Record<SectionKey, number>>) {
	try {
		localStorage.setItem(SECTION_PAGE_SIZE_KEY, JSON.stringify(sizes));
	} catch {
		// best-effort
	}
}
