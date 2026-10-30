import { AlertCircleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useState } from "react";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import StoreCatalogCard from "./chrome/store-catalog-card.tsx";
import { StoreCardGrid } from "./chrome/store-catalog-layout.tsx";
import StoreItemAction, {
	storeItemContextMenu,
} from "./chrome/store-item-action.tsx";
import StoreShelfHeading from "./chrome/store-shelf-heading.tsx";
import type { PluginSettingsOpener } from "./host.tsx";
import { REALM_ICONS } from "./realm-icons.ts";
import {
	formatCount,
	groupSkillsBySource,
} from "./skills-catalog-section-model.ts";
import type { SkillCard } from "./types.ts";

export function SkillList({
	skills,
	loading,
	error,
	selectedId,
	onSelect,
	groupBySource,
	cardInstall,
	setSkillEnabled,
	enabledByKey,
	installing,
	togglingSkill,
	fetchNextPage,
	hasNextPage,
	onClearFilters,
	onRetry,
	settingsOpener,
}: {
	skills: SkillCard[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	groupBySource: boolean;
	cardInstall: (id: string) => void;
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	enabledByKey: Record<string, boolean>;
	installing: string | null;
	togglingSkill: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	onClearFilters: () => void;
	onRetry: () => void;
	/** Resolves a card to the settings of the plugin that ships it, when one does. */
	settingsOpener: PluginSettingsOpener;
}) {
	const tl = useLiteralMessages();
	// The IntersectionObserver root is the layout's scroll column, not the viewport.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
	const sections = groupBySource
		? groupSkillsBySource(skills)
		: [{ id: "all", label: "", skills }];
	const sourceShelved = groupBySource && sections.length > 1;
	const renderCard = (s: SkillCard) => (
		<StoreCatalogCard
			action={
				<SkillCardAction
					card={s}
					downloadCount={s.downloads}
					enabled={enabledByKey[s.id]}
					installBusy={installing === s.id}
					onDisable={() => {
						setSkillEnabled(s.id, false).catch(() => undefined);
					}}
					onEnable={() => {
						setSkillEnabled(s.id, true).catch(() => undefined);
					}}
					onInstall={() => cardInstall(s.id)}
					onOpenSettings={settingsOpener(s.id)}
					toggleBusy={togglingSkill === s.id}
				/>
			}
			// The same verbs the card's own control offers, installed states
			// included — the gesture used to work only on skills you had not
			// added yet, which is the half with the least to do to it.
			contextMenu={storeItemContextMenu({
				enabled: s.installed ? enabledByKey[s.id] : undefined,
				installed: s.installed,
				onDisable: () => {
					setSkillEnabled(s.id, false).catch(() => undefined);
				},
				onEnable: () => {
					setSkillEnabled(s.id, true).catch(() => undefined);
				},
				onInstall: () => cardInstall(s.id),
				onOpenSettings: settingsOpener(s.id) ?? undefined,
			})}
			// The SKILL.md one-liner when the source could give us one
			// without a per-card round trip (installed skills always can),
			// else the provenance line every card showed before.
			description={
				s.description?.trim() ||
				(s.installs > 0
					? tl("{source} · {installs} installs", {
							installs: formatCount(s.installs),
							source: s.source,
						})
					: s.source)
			}
			icon={<HugeiconsIcon className="size-5" icon={REALM_ICONS.skills} />}
			key={s.id}
			// A skill's `owner/repo[/subdir]` id IS its namespace — the same
			// string the fetcher installs from — so it keys likes exactly as
			// an app's `@scope/name` does.
			likeNamespace={s.id}
			name={s.name}
			onClick={() => onSelect(s.id)}
			seedId={s.id}
			selected={s.id === selectedId}
		/>
	);

	if (loading && skills.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={AlertCircleIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn&apos;t load skills</EmptyTitle>
					<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="outline">
						Try again
					</Button>
					<StoreErrorDetails message={error} />
				</EmptyContent>
			</Empty>
		);
	}
	if (skills.length === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Search01Icon} />
					</EmptyMedia>
					<EmptyTitle>No skills found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearFilters} size="sm" variant="ghost">
						Clear filters
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div ref={setScrollEl}>
			{sourceShelved ? (
				<div className="flex flex-col gap-6">
					{sections.map((section) => (
						<section key={section.id}>
							<StoreShelfHeading>{section.label}</StoreShelfHeading>
							<StoreCardGrid>{section.skills.map(renderCard)}</StoreCardGrid>
						</section>
					))}
				</div>
			) : (
				<StoreCardGrid>{skills.map(renderCard)}</StoreCardGrid>
			)}
			{/* Paging is a synchronous client-side reveal, so there is no in-flight
			    flag: the grown row count is what releases the sentinel's latch. */}
			<InfiniteSentinel
				hasMore={hasNextPage}
				itemCount={skills.length}
				loading={false}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
		</div>
	);
}

/** Card action for a skill: Add (not installed) or an Enabled↔Disabled morph
 *  once installed. `enabled` is `enabledByKey[id]` (undefined when the on-disk key
 *  isn't the card id, which collapses to the plain "Installed" affordance). */
function SkillCardAction({
	card,
	enabled,
	installBusy,
	downloadCount,
	toggleBusy,
	onInstall,
	onEnable,
	onDisable,
	onOpenSettings,
}: {
	card: SkillCard;
	enabled: boolean | undefined;
	installBusy: boolean;
	downloadCount?: number | null;
	toggleBusy: boolean;
	onInstall: () => void;
	onEnable: () => void;
	onDisable: () => void;
	/** Set for a skill shipped by an installed plugin that declares settings; a
	 *  plain SKILL.md has none and gets no Settings row. */
	onOpenSettings?: (() => void) | null;
}) {
	return (
		<StoreItemAction
			busy={installBusy || toggleBusy}
			downloadCount={downloadCount}
			enabled={card.installed ? enabled : undefined}
			installed={card.installed}
			onDisable={onDisable}
			onEnable={onEnable}
			onInstall={onInstall}
			onOpenSettings={onOpenSettings ?? undefined}
		/>
	);
}
