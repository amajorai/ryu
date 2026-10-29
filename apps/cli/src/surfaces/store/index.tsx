/* @jsxImportSource @opentui/react */
// Store surface - the unified catalog shell that mirrors apps/desktop StorePage.
// One screen with a store-wide search box, a section tab-row (Plugins · Sidecars ·
// Models · Skills · MCP · Agents · Engines · Fine-tune), and a body that swaps between
// the active section's content and the aggregated search results.
//
// This is a SHELL + REGROUPING, not a rewrite: each section reuses an existing tab
// content component unchanged (Plugins<-plugins.tsx [the REAL /api/plugins lifecycle
// surface], Sidecars<-apps.tsx [the /api/catalog binary catalog], Models<-models.tsx,
// Skills<-skills.tsx, MCP<-tools.tsx, Agents<-agents.tsx, Engines<-engines.tsx), while
// Fine-tune is a light fresh panel. Only the active section is mounted, so its
// keyboard handler is the only child handler live.
//
// Keyboard ownership: the shell owns the search-focus toggle and section switching;
// each mounted section (and the search results) own their own list keys. The shell
// gates on `focused = active && focusedPaneId === paneId`, and while the search
// input is focused it claims raw input (useSetInputFocused) so the mounted section
// and shell globals stay quiet.

import { useKeyboard } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	useSetInputFocused,
	useShellKeyboardCaptured,
} from "../../core/InputFocusContext.tsx";
import { HINT, hintText } from "../../core/keymap.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import { displayWidth, truncateLabel } from "../../sidebar/rows.ts";
import { AgentsTab } from "../../tabs/agents.tsx";
import { AppsTab } from "../../tabs/apps.tsx";
import { EnginesTab } from "../../tabs/engines.tsx";
import { ModelsTab } from "../../tabs/models.tsx";
import { PluginsTab } from "../../tabs/plugins.tsx";
import { SkillsTab } from "../../tabs/skills.tsx";
import { ToolsTab } from "../../tabs/tools.tsx";
import { ConfirmClaimContext } from "../../ui/ConfirmPrompt.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import {
	leadingOverflowLabel,
	MAX_TAB_LABEL,
	trailingOverflowLabel,
	visibleTabWindow,
} from "../../workspace/tabStripLayout.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import { FinetunePanel } from "./Finetune.tsx";
import { StoreSearch } from "./StoreSearch.tsx";
import {
	STORE_SECTIONS,
	type StoreSection,
	sectionFromPath,
} from "./sections.ts";

// Resolve this instance's tab path (this pane's active tab) so the initial section
// can be derived from the path the shell opened (/store, /store/models, /models…).
function pathForPane(
	panes: { activeTabId: string | null; id: string }[],
	tabs: { id: string; path: string }[],
	paneId: string
): string {
	const pane = panes.find((p) => p.id === paneId);
	const tab = tabs.find((t) => t.id === pane?.activeTabId);
	return tab?.path ?? "/store";
}

function StoreSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { panes, tabs, focusedPaneId } = useWorkspace();
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: externalOverlayId } = useOverlay();
	const setInputFocused = useSetInputFocused();

	// Decide the section once from the opening path (desktop parity); the tab-row
	// then switches it in place.
	const [section, setSection] = useState<StoreSection>(() =>
		sectionFromPath(pathForPane(panes, tabs, paneId))
	);
	const [query, setQuery] = useState("");
	const [searchFocused, setSearchFocused] = useState(false);
	// A section's destructive-action ConfirmPrompt is open: it owns ←/→ (button
	// focus) and every plain key, so the Store must not switch sections or open
	// search underneath it (that would silently drop the pending prompt).
	const [confirmOpen, setConfirmOpen] = useState(false);

	const focused = active && focusedPaneId === paneId;
	const hasQuery = query.trim().length > 0;
	const keyboardCaptured = shellKeyboardCaptured || externalOverlayId !== null;
	const searchInputActive = focused && searchFocused && !keyboardCaptured;
	const contentActive =
		focused && !searchFocused && !hasQuery && !keyboardCaptured;
	const searchResultsActive =
		focused && !searchFocused && hasQuery && !keyboardCaptured;

	// Claim raw input while the search box is focused so the mounted section and the
	// shell's plain-key globals stay quiet.
	useEffect(() => {
		setInputFocused(searchInputActive);
		return () => setInputFocused(false);
	}, [searchInputActive, setInputFocused]);

	const switchSection = (delta: number) => {
		setSection((current) => {
			const at = STORE_SECTIONS.findIndex((s) => s.id === current);
			const nextAt =
				(at + delta + STORE_SECTIONS.length) % STORE_SECTIONS.length;
			return STORE_SECTIONS[nextAt].id;
		});
		setQuery("");
	};

	const openRealm = (next: StoreSection) => {
		setSection(next);
		setQuery("");
		setSearchFocused(false);
	};

	useKeyboard((key) => {
		if (!focused || keyboardCaptured || confirmOpen) {
			return;
		}
		if (searchFocused) {
			// Typing mode: leave the input on Esc, or hand off to results on Enter/Down.
			if (
				key.name === "escape" ||
				key.name === "return" ||
				key.name === "down"
			) {
				setSearchFocused(false);
			}
			return;
		}
		if (key.ctrl || key.meta || key.option) {
			// Chords are the shell's (Alt+←/→ moves between panes).
			return;
		}
		if (key.name === "/" || key.sequence === "/") {
			setSearchFocused(true);
		} else if (key.name === "left") {
			switchSection(-1);
		} else if (key.name === "right") {
			switchSection(1);
		}
		// Every other key falls through to the mounted section / search results, which
		// own their own list navigation.
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<SearchBar
				focused={searchInputActive}
				onChange={setQuery}
				query={query}
				theme={theme}
			/>
			<SectionTabRow active={section} onSelect={openRealm} theme={theme} />
			<box flexDirection="column" flexGrow={1}>
				{hasQuery ? (
					<StoreSearch
						active={searchResultsActive}
						onOpen={openRealm}
						query={query}
					/>
				) : (
					<ConfirmClaimContext.Provider value={setConfirmOpen}>
						<SectionContent active={contentActive} section={section} />
					</ConfirmClaimContext.Provider>
				)}
			</box>
			<HintLine hasQuery={hasQuery} theme={theme} />
		</box>
	);
}

type ThemeValue = ReturnType<typeof useTheme>;

function SearchBar({
	query,
	focused,
	onChange,
	theme,
}: {
	focused: boolean;
	onChange: (value: string) => void;
	query: string;
	theme: ThemeValue;
}) {
	return (
		<box
			borderColor={focused ? theme.colors.focusRing : theme.colors.border}
			borderStyle="rounded"
			flexDirection="row"
			gap={1}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.mutedForeground}>{"⌕"}</text>
			<input
				cursorColor={theme.colors.primary}
				focused={focused}
				focusedTextColor={theme.colors.foreground}
				onInput={onChange}
				placeholder="Search the whole store — models, skills, MCP, plugins…"
				placeholderColor={theme.colors.mutedForeground}
				textColor={theme.colors.foreground}
				value={query}
			/>
		</box>
	);
}

function SectionTabRow({
	active,
	onSelect,
	theme,
}: {
	active: StoreSection;
	onSelect: (section: StoreSection) => void;
	theme: ThemeValue;
}) {
	// One row that never wraps: every label is padded " label " so the active
	// fill does not shift its neighbours, and a click switches the section. When
	// the pane is too narrow for every label, a window around the active section
	// is shown with "‹ +N" / "+M ›" markers (click one to step that way).
	const [rowWidth, setRowWidth] = useState<number | null>(null);
	const labels = STORE_SECTIONS.map((meta) =>
		truncateLabel(meta.label, MAX_TAB_LABEL)
	);
	const activeIndex = Math.max(
		0,
		STORE_SECTIONS.findIndex((meta) => meta.id === active)
	);
	const { start, end } = visibleTabWindow(
		labels.map((label) => displayWidth(` ${label} `)),
		activeIndex,
		rowWidth ?? Number.POSITIVE_INFINITY,
		0
	);
	const selectAt = (index: number) => () => {
		const meta = STORE_SECTIONS[index];
		if (meta) {
			onSelect(meta.id);
		}
	};
	return (
		<box
			flexDirection="row"
			flexShrink={0}
			flexWrap="no-wrap"
			onSizeChange={function measure(this: { width: number }) {
				setRowWidth(this.width);
			}}
			overflow="hidden"
			paddingTop={1}
		>
			{start > 0 ? (
				<text
					fg={theme.colors.mutedForeground}
					flexShrink={0}
					onMouseDown={selectAt(start - 1)}
					wrapMode="none"
				>
					{leadingOverflowLabel(start)}
				</text>
			) : null}
			{STORE_SECTIONS.slice(start, end).map((meta, offset) => {
				const isActive = meta.id === active;
				const label = labels[start + offset] ?? meta.label;
				return (
					<box
						backgroundColor={isActive ? theme.colors.selection : undefined}
						flexShrink={0}
						key={meta.id}
						onMouseDown={() => onSelect(meta.id)}
					>
						<text
							fg={
								isActive
									? theme.colors.selectionForeground
									: theme.colors.mutedForeground
							}
							wrapMode="none"
						>
							{" "}
							{isActive ? <b>{label}</b> : label}{" "}
						</text>
					</box>
				);
			})}
			{end < STORE_SECTIONS.length ? (
				<text
					fg={theme.colors.mutedForeground}
					flexShrink={0}
					onMouseDown={selectAt(end)}
					wrapMode="none"
				>
					{trailingOverflowLabel(STORE_SECTIONS.length - end)}
				</text>
			) : null}
		</box>
	);
}

function SectionContent({
	section,
	active,
}: {
	active: boolean;
	section: StoreSection;
}): ReactNode {
	if (section === "plugins") {
		return <PluginsTab active={active} />;
	}
	if (section === "apps") {
		return <AppsTab active={active} />;
	}
	if (section === "models") {
		return <ModelsTab active={active} />;
	}
	if (section === "skills") {
		return <SkillsTab active={active} />;
	}
	if (section === "mcp") {
		return <ToolsTab active={active} />;
	}
	if (section === "agents") {
		return <AgentsTab active={active} />;
	}
	if (section === "engines") {
		return <EnginesTab active={active} />;
	}
	return <FinetunePanel active={active} />;
}

// The Store's one hint line, in the shared HINT vocabulary.
const SEARCH_HINT = hintText([
	HINT.search,
	HINT.move,
	{ keys: "Enter", label: "open realm" },
	HINT.refresh,
]);
const BROWSE_HINT = hintText([
	HINT.search,
	{ keys: "←→", label: "sections" },
	HINT.move,
	{ keys: "Enter/a", label: "act" },
	HINT.refresh,
]);

function HintLine({
	hasQuery,
	theme,
}: {
	hasQuery: boolean;
	theme: ThemeValue;
}) {
	const hint = hasQuery ? SEARCH_HINT : BROWSE_HINT;
	return (
		<box paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.mutedForeground}>{hint}</text>
		</box>
	);
}

// ── Surface modules ─────────────────────────────────────────────────────────
// One shared StoreSurface component behind several path owners. The primary module
// owns the /store prefix; the deep-link modules let Integrate point the standalone
// catalog paths at this same shell, each landing on the right tab-row entry (the
// section is derived from the tab path via sectionFromPath).

/** Primary Store surface. Owns /store and /store/<section>. */
export const storeSurface: SurfaceModule = {
	id: "store",
	title: "Store",
	icon: "▣",
	match: (path) => path === "/store" || path.startsWith("/store/"),
	Component: StoreSurface,
};

/** Deep link: /models -> Store on the Models section. */
export const storeModelsSurface: SurfaceModule = {
	id: "store-models",
	title: "Models",
	match: (path) => path === "/models" || path.startsWith("/models/"),
	Component: StoreSurface,
};

/** Deep link: /skills -> Store on the Skills section. */
export const storeSkillsSurface: SurfaceModule = {
	id: "store-skills",
	title: "Skills",
	match: (path) => path === "/skills" || path.startsWith("/skills/"),
	Component: StoreSurface,
};

/** Deep link: /engines -> Store on the Engines section. */
export const storeEnginesSurface: SurfaceModule = {
	id: "store-engines",
	title: "Engines",
	match: (path) => path === "/engines" || path.startsWith("/engines/"),
	Component: StoreSurface,
};

/** Deep link: /finetune -> Store on the Fine-tune section. */
export const storeFinetuneSurface: SurfaceModule = {
	id: "store-finetune",
	title: "Fine-tune",
	match: (path) => path === "/finetune" || path.startsWith("/finetune/"),
	Component: StoreSurface,
};
