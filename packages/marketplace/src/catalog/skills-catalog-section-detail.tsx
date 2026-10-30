import {
	Add01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	PencilEdit01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type { ComponentType } from "react";
import {
	ListingDetailShell,
	ListingHero,
	ListingSection,
	ListingStatStrip,
} from "./detail/listing-detail-shell.tsx";
import { ScorecardPanel } from "./detail/scorecard-panel.tsx";
import { skillOrg, titleCase } from "./friendly.ts";
import type {
	CatalogHost,
	CatalogInstall,
	CatalogMarkdownProps,
} from "./host.tsx";
import { runSkillScorecard } from "./scorecard.ts";
import { SkillDetailAside } from "./skills-catalog-section-detail-aside.tsx";
import {
	formatCount,
	resolveSkillKey,
	skillStatItems,
	skillTrustLabel,
} from "./skills-catalog-section-model.ts";
import type { SkillCard, SkillDetail } from "./types.ts";

export function SkillDetailPanel({
	selectedId,
	detail,
	distributeSkill,
	loading,
	error,
	install,
	installing,
	friendly,
	onSelectOrg,
	enabledByKey,
	onToggleEnabled,
	togglingSkill,
	onCreate,
	onEdit,
	canAuthor,
	installLayer,
	renderAffordance,
	auditScope,
	runCatalogScan,
	onOpenAuditConversation,
	Markdown,
}: {
	selectedId: string | null;
	detail: SkillDetail | null;
	distributeSkill: CatalogHost["distributeSkill"];
	loading: boolean;
	error: string | null;
	install: () => Promise<void>;
	installing: string | null;
	friendly: boolean;
	onSelectOrg: (org: string) => void;
	enabledByKey: Record<string, boolean>;
	onToggleEnabled: (id: string, active: boolean) => Promise<void>;
	togglingSkill: string | null;
	onCreate: () => void;
	onEdit: (skillId: string) => void;
	canAuthor: boolean;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
	auditScope: string;
	runCatalogScan: CatalogHost["runCatalogScan"];
	onOpenAuditConversation?: (id: string) => void;
	Markdown: ComponentType<CatalogMarkdownProps>;
}) {
	const tl = useLiteralMessages();
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={SparklesIcon} />
					</EmptyMedia>
					<EmptyTitle>No skill selected</EmptyTitle>
					<EmptyDescription>
						{canAuthor
							? tl(
									"Pick a skill on the left to read what it does and add it to your agents — or author your own."
								)
							: tl(
									"Pick a skill on the left to read what it does and add it to your agents."
								)}
					</EmptyDescription>
				</EmptyHeader>
				{canAuthor ? (
					<EmptyContent>
						<Button onClick={onCreate}>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New skill
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}
	if (loading && !detail) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-sm text-status-destructive">
				{tl("Couldn't load this skill: {error}", { error })}
			</div>
		);
	}
	if (!detail) {
		return null;
	}

	const { card, description, metadata, readme, url } = detail;
	// On-disk skill id for the enable/disable toggle (null when unresolvable, so
	// the toggle degrades to the plain "Installed" badge instead of silently
	// targeting a non-existent id).
	const skillKey = resolveSkillKey(enabledByKey, card);
	const skillEnabled = skillKey ? (enabledByKey[skillKey] ?? false) : false;
	const isToggling = skillKey !== null && togglingSkill === skillKey;
	const owner = skillOrg(card);
	const installs =
		metadata.installs ??
		(card.installs > 0 ? formatCount(card.installs) : null);
	// Only show a Downloads figure when the skill actually reports one; falling
	// back to the Installs value would render two rows with an identical number,
	// which reads as a data error.
	const downloads =
		(card.downloads ?? 0) > 0 ? formatCount(card.downloads ?? 0) : null;

	const title = friendly ? titleCase(card.name) : card.name;
	const sourceLabel = card.source || "skills.sh";
	const trustLabel = skillTrustLabel(card.trustLevel);
	const scorecard = runSkillScorecard(card, detail);
	const agentScan = runCatalogScan
		? () =>
				runCatalogScan({
					description,
					files: detail.files,
					id: card.id,
					kind: "skill",
					metadata: {
						githubStars: metadata.githubStars,
						repositoryUrl: metadata.repositoryUrl,
						securityAudits: metadata.securityAudits,
						source: card.source,
						trustLevel: card.trustLevel,
					},
					name: card.name,
					readme,
					scorecard,
				})
		: undefined;

	return (
		<ListingDetailShell
			actions={
				<>
					<SkillDetailAction
						canAuthor={canAuthor}
						card={card}
						distributeSkill={distributeSkill}
						install={install}
						installing={installing}
						installLayer={installLayer}
						isToggling={isToggling}
						onEdit={onEdit}
						onToggleEnabled={onToggleEnabled}
						renderAffordance={renderAffordance}
						skillEnabled={skillEnabled}
						skillKey={skillKey}
					/>
					<span className="ml-auto flex shrink-0 items-center gap-2">
						{owner ? (
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											className="text-muted-foreground text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
											onClick={() => onSelectOrg(owner)}
											type="button"
										>
											{tl("More by {owner}", { owner })}
										</button>
									}
								/>
								<TooltipContent>
									{tl("Browse all skills by {owner}", { owner })}
								</TooltipContent>
							</Tooltip>
						) : null}
					</span>
				</>
			}
			aside={
				<SkillDetailAside
					metadata={metadata}
					sourceLabel={sourceLabel}
					url={url}
				/>
			}
			hero={
				<ListingHero
					badges={[
						card.installed ? (skillEnabled ? "Enabled" : "Added") : null,
						sourceLabel,
						trustLabel,
					].filter((b): b is string => Boolean(b))}
					icon={
						// Skills carry no art of their own — no manifest, no icon field. The
						// generative tile keyed on the skill id is the same rule
						// `AppIcon` uses for an artless app, so a skill still reads as
						// *that* skill rather than as one repeated grey glyph.
						<DitherAvatar
							animate={false}
							className="size-full"
							name={card.id}
						/>
					}
					name={title}
					tagline={description}
				/>
			}
			stats={
				<ListingStatStrip
					items={skillStatItems({ downloads, installs, metadata })}
				/>
			}
		>
			<ListingSection title="Health">
				<ScorecardPanel
					agentScan={agentScan}
					key={JSON.stringify([auditScope, detail])}
					onOpenConversation={onOpenAuditConversation}
					scorecard={scorecard}
				/>
			</ListingSection>
			{readme ? (
				<ListingSection title="README">
					<div className="prose prose-sm dark:prose-invert max-w-none text-sm">
						<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={readme} />
					</div>
				</ListingSection>
			) : (
				<p className="text-muted-foreground text-sm">
					This skill ships no README.
				</p>
			)}
		</ListingDetailShell>
	);
}

/** The primary action cluster in the skill detail header: install / enable-toggle
 *  on an install-capable surface (desktop), or the read-only "Open in Ryu"
 *  affordance where `installLayer` is null (web). */
function SkillDetailAction({
	card,
	distributeSkill,
	install,
	installing,
	installLayer,
	renderAffordance,
	skillKey,
	skillEnabled,
	isToggling,
	onToggleEnabled,
	onEdit,
	canAuthor,
}: {
	card: SkillCard;
	distributeSkill: CatalogHost["distributeSkill"];
	install: () => Promise<void>;
	installing: string | null;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
	skillKey: string | null;
	skillEnabled: boolean;
	isToggling: boolean;
	onToggleEnabled: (id: string, active: boolean) => Promise<void>;
	onEdit: (skillId: string) => void;
	canAuthor: boolean;
}) {
	if (!installLayer) {
		// Read-only surface: no local install; deep-link into the Ryu app instead.
		return (
			renderAffordance?.({
				id: card.id,
				name: card.name,
				realm: "skill",
			}) ?? null
		);
	}

	if (!card.installed) {
		const InstallButton = installLayer.InstallButton;
		return (
			<InstallButton
				idleVariant="ghost"
				installing={installing === card.id}
				onClick={() => {
					install().catch(() => undefined);
				}}
				progress={{ kinds: ["skill"], name: card.name }}
			>
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Add skill
			</InstallButton>
		);
	}

	return (
		<div className="flex shrink-0 items-center gap-3">
			{distributeSkill ? (
				<Button
					onClick={() => {
						distributeSkill(card.id).catch(() => undefined);
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Use with agents
				</Button>
			) : null}
			{canAuthor && skillKey !== null ? (
				<Button onClick={() => onEdit(skillKey)} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Edit
				</Button>
			) : null}
			<Badge variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-status-success"
					icon={CheckmarkCircle02Icon}
				/>
				Added
			</Badge>
			{skillKey === null ? null : (
				<div className="flex items-center gap-1.5">
					{isToggling ? <Spinner className="size-3.5" /> : null}
					<Switch
						aria-label={skillEnabled ? "Disable skill" : "Enable skill"}
						checked={skillEnabled}
						disabled={isToggling}
						id={`skill-enabled-${card.id}`}
						onCheckedChange={(v) => {
							onToggleEnabled(skillKey, v).catch(() => undefined);
						}}
					/>
					<Label
						className="cursor-pointer"
						htmlFor={`skill-enabled-${card.id}`}
						size="compact"
						tone="muted"
					>
						{skillEnabled ? "Enabled" : "Disabled"}
					</Label>
				</div>
			)}
		</div>
	);
}
