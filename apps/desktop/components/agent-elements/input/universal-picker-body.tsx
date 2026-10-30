"use client";

// The universal picker's dropdown BODY. Fed to `ComposerSettingsMenu` via its
// `renderBody` prop, so the trigger summary (`Ryu · Sonnet · Plan`) is unchanged;
// only the popover body is owned here.
//
// Compact root (no search query) — one row per TARGET, everything else nested:
//   1. Ryu          — the flagship `ryu` agent, ONE row. Its submenu holds
//                      "Use Ryu", the live model + thinking pickers when it's the
//                      active target, and the full Providers list (every Pi
//                      provider the Ryu agent can route to — they are routes OF
//                      the Ryu agent, not sibling targets). A configured provider
//                      drills into its models + thinking; an unconfigured one
//                      offers a single "Configure credentials" row.
//   2. External agents — installed ACP harnesses (Claude Code, Codex, Gemini CLI,
//                      …) drill into their advertised model / thinking / approval,
//                      probed LAZILY on submenu-open (one subprocess, not a storm).
//   3. Add more agents — ONE row out to the Customize page when the catalog has
//                      anything left to install. It is a link, not a list: this
//                      picker chooses a TARGET for the next turn, and the
//                      not-yet-installed catalog it used to nest here duplicated
//                      a browsing surface the marketplace already owns.
//
// Typing in the search box flattens everything back out (providers and
// installable agents surface as top-level matches, the latter still with their
// inline Install button) so nesting never hides a target from search — and a
// user who knows the name of an agent they have not installed yet still finds
// it here without the round trip.
//
// The lazy probe is the load-bearing detail: `DropdownMenuSubContent` (Base UI,
// `keepMounted={false}`) unmounts a closed submenu's children, so
// `ExternalAgentSettings` only calls `useComposerAcpSections` (which spawns the
// agent subprocess on first fetch) when its submenu is actually opened.

import { Add01Icon, Store01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import type {
	UniversalPickerBodyProps,
	UniversalPickerBodyScope,
} from "./universal-picker-body-scope.ts";
import { useUniversalPickerFilters } from "./universal-picker-filters.ts";
import { RecentAgentRow, RecentModelRow } from "./universal-picker-recents.tsx";
import { getUniversalPickerRows } from "./universal-picker-row-renderers.tsx";
import {
	AutoTargetRow,
	AvailableAgentRow,
	SectionHeader,
} from "./universal-picker-rows.tsx";
import { SettingSub } from "./universal-picker-settings.tsx";
import { AUTO_AGENT_ID } from "./universal-picker-types.ts";

export type { UniversalPickerBodyProps } from "./universal-picker-body-scope.ts";
export {
	AUTO_AGENT_ID,
	type ProviderEntry,
	type TeamEntry,
	type UniversalPickerData,
} from "./universal-picker-types.ts";

export function UniversalPickerBody({
	mode = "all",
	...props
}: UniversalPickerBodyProps) {
	// Each hook reads only bindings that earlier hooks already assigned.
	const tl = useLiteralMessages();
	const scope = { ...props, mode, tl } as UniversalPickerBodyScope;
	Object.assign(scope, useUniversalPickerFilters(scope));
	Object.assign(scope, getUniversalPickerRows(scope));
	const {
		showSearch,
		setQuery,
		query,
		activeModelSection,
		nothingMatches,
		q,
		recentModelRowsForDisplay,
		recentAgentRowsForDisplay,
		showProviders,
		onRemoveRecent,
		selectRecent,
		showAgents,
		autoVisible,
		autoActive,
		onSelectAgent,
		ryuVisible,
		ryuSub,
		filteredProviders,
		providerSub,
		filteredInstalled,
		filteredCustom,
		externalSub,
		customAgentRow,
		filteredAvailable,
		installPendingId,
		onInstallExternal,
		providers,
		openAgentsCatalog,
		availableExternal,
		filteredTeams,
		onSelectTeam,
		onCreateAgent,
		close,
	} = scope;
	return (
		<div className="flex flex-col">
			{showSearch && (
				<div className="px-2 pb-1">
					<Input
						aria-label="Search agents, providers and models"
						onChange={(e) => setQuery(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
						onPointerDown={(e) => e.stopPropagation()}
						placeholder="Search agents, providers…"
						spellCheck={false}
						value={query}
						variant="picker-search"
					/>
				</div>
			)}

			<div className="min-h-0 flex-1">
				{mode === "models" && activeModelSection && (
					<SettingSub section={activeModelSection} />
				)}
				{nothingMatches && (
					<p className="px-3 py-4 text-center text-muted-foreground text-xs">
						{tl("No matches for “{query}”", { query: query.trim() })}
					</p>
				)}

				{!q &&
				(recentModelRowsForDisplay.length > 0 ||
					recentAgentRowsForDisplay.length > 0) ? (
					<>
						<SectionHeader label="Recent" />
						{showProviders &&
							recentModelRowsForDisplay.map((row, index) => (
								<RecentModelRow
									effort={row.effort}
									key={`model:${row.provider.id}:${row.model.id}`}
									model={row.model}
									modelRef={row.ref}
									onRemove={onRemoveRecent}
									onSelect={selectRecent}
									provider={row.provider}
									testId={`recent-model-row-${index}`}
								/>
							))}
						{showAgents &&
							recentAgentRowsForDisplay.map((row, index) => (
								<RecentAgentRow
									agent={row.agent}
									agentRef={row.ref}
									key={`agent:${row.agent.id}`}
									onRemove={onRemoveRecent}
									onSelect={selectRecent}
									testId={`recent-agent-row-${index}`}
								/>
							))}
					</>
				) : null}

				{/* Auto (Plane B — Core picks the agent per-turn) */}
				{showAgents && autoVisible && (
					<AutoTargetRow
						isActive={autoActive}
						onSelect={() => {
							onSelectAgent(AUTO_AGENT_ID);
						}}
					/>
				)}

				{q ? (
					// ── Search results: flattened so nesting never hides a match ──
					<>
						{showAgents && ryuVisible && ryuSub}
						{showProviders && filteredProviders.length > 0 && (
							<>
								<SectionHeader label="Providers" />
								{filteredProviders.map(providerSub)}
							</>
						)}
						{showAgents &&
							(filteredInstalled.length > 0 || filteredCustom.length > 0) && (
								<>
									<SectionHeader label="Agents" />
									{filteredInstalled.map(externalSub)}
									{filteredCustom.map(customAgentRow)}
								</>
							)}
						{showAgents && filteredAvailable.length > 0 && (
							<>
								<SectionHeader label="Not installed" />
								{filteredAvailable.map((entry) => (
									<AvailableAgentRow
										entry={entry}
										installing={installPendingId === entry.id}
										key={entry.id}
										onInstall={() => onInstallExternal(entry.id)}
									/>
								))}
							</>
						)}
					</>
				) : (
					// ── Compact root: one row per target ──
					<>
						{showAgents && ryuSub}
						{showAgents && filteredInstalled.map(externalSub)}
						{showAgents && filteredCustom.map(customAgentRow)}
						{showProviders && !q && providers.map(providerSub)}
						{/* One row out to the marketplace, not a second catalog nested
						    inside this one. The submenu that used to live here re-listed
						    every not-yet-installed agent with its own Install buttons —
						    a browsing surface the Customize page already owns, and one
						    that made a picker-for-choosing-a-target double as a store.
						    Searching still surfaces installable agents inline (the
						    "Not installed" branch above), so nothing became unreachable. */}
						{showAgents &&
							openAgentsCatalog &&
							availableExternal.length > 0 && (
								<DropdownMenuItem
									onClick={() => {
										openAgentsCatalog();
										close();
									}}
									spacing="comfortable"
								>
									<HugeiconsIcon
										className="shrink-0 text-muted-foreground"
										icon={Store01Icon}
										size={16}
										strokeWidth={2}
									/>
									<span className="flex-1 truncate">Add more agents</span>
								</DropdownMenuItem>
							)}
					</>
				)}

				{/* Groups (preserved from the legacy picker when present) */}
				{showAgents && filteredTeams.length > 0 && onSelectTeam && (
					<>
						<SectionHeader label="Groups" />
						{filteredTeams.map((team) => (
							<DropdownMenuItem
								active={team.isActive}
								closeOnClick={false}
								key={team.id}
								onClick={() => {
									onSelectTeam(team.id);
								}}
								spacing="comfortable"
							>
								<AgentLogo
									className="size-4 shrink-0"
									engine={team.engines[0] ?? null}
									size="16px"
								/>
								<span className="flex-1 truncate">{team.name}</span>
								{team.isActive && (
									<HugeiconsIcon
										className="shrink-0 text-muted-foreground"
										icon={Tick02Icon}
										size={16}
										strokeWidth={2}
									/>
								)}
							</DropdownMenuItem>
						))}
					</>
				)}

				{/* Create new agent — a plus, because this row AUTHORS an agent. It
				    used to wear the download glyph, which read as "fetch one from
				    somewhere" and collided with the row above it. */}
				{showAgents && onCreateAgent && !q && (
					<DropdownMenuItem
						onClick={() => {
							onCreateAgent();
							close();
						}}
						spacing="comfortable"
					>
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={Add01Icon}
							size={16}
							strokeWidth={2}
						/>
						<span className="flex-1 truncate">Create new agent</span>
					</DropdownMenuItem>
				)}
			</div>
		</div>
	);
}
