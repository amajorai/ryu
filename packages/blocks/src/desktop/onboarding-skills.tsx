"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { OnboardingCheckRow } from "./onboarding-agents.tsx";
import { OnboardingActions, OnboardingCta } from "./onboarding-shell.tsx";
import type {
	OnboardingSkillPackOption,
	OnboardingViewProps,
} from "./onboarding-types.ts";

export function SkillPackRow({
	pack,
	isSelected,
	disabled,
	onToggle,
}: {
	pack: OnboardingSkillPackOption;
	isSelected: boolean;
	disabled: boolean;
	onToggle?: (id: string) => void;
}) {
	return (
		<OnboardingCheckRow
			disabled={disabled}
			isSelected={isSelected}
			onToggle={() => onToggle?.(pack.id)}
			testId={`onboarding-skill-pack-${pack.id.replaceAll("/", "-")}`}
		>
			<span className="block font-medium text-sm">{pack.name}</span>
			<span className="block text-pretty text-detail text-muted-foreground">
				{pack.description}
			</span>
		</OnboardingCheckRow>
	);
}

export function SkillPackPicker({
	skillPacks = [],
	skillPacksCanConfigure = true,
	skillPacksError,
	skillPacksLoading = false,
	selectedSkillPackIds,
	skillPacksSubmitting = false,
	onClearAllSkillPacks,
	onContinueSkillPacks,
	onRetrySkillPacks,
	onSelectAllSkillPacks,
	onToggleSkillPack,
}: Pick<
	OnboardingViewProps,
	| "skillPacks"
	| "skillPacksCanConfigure"
	| "skillPacksError"
	| "skillPacksLoading"
	| "selectedSkillPackIds"
	| "skillPacksSubmitting"
	| "onClearAllSkillPacks"
	| "onContinueSkillPacks"
	| "onRetrySkillPacks"
	| "onSelectAllSkillPacks"
	| "onToggleSkillPack"
>) {
	const tl = useLiteralMessages();
	const selectedCount = selectedSkillPackIds?.size ?? 0;
	const disabled =
		skillPacksLoading ||
		skillPacksSubmitting ||
		!skillPacksCanConfigure ||
		Boolean(skillPacksError);
	return (
		<>
			<div className="flex flex-col gap-1">
				<div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-3">
					<p className="font-semibold text-foreground text-sm">
						Recommended skill collections
					</p>
					<div className="flex gap-1">
						<Button
							disabled={disabled}
							onClick={onSelectAllSkillPacks}
							size="sm"
							variant="ghost-muted"
						>
							Select all
						</Button>
						<Button
							disabled={disabled}
							onClick={onClearAllSkillPacks}
							size="sm"
							variant="ghost-muted"
						>
							Unselect all
						</Button>
					</div>
				</div>
				<p className="mb-2 px-3 text-detail text-muted-foreground">
					Ryu&apos;s built-in skills and skills contributed by enabled Ryu
					plugins stay available and are not part of this choice.
				</p>

				{skillPacksError ? (
					<div className="flex items-start gap-3 px-3 py-2" role="alert">
						<div className="min-w-0 flex-1">
							<p className="text-sm">
								Couldn&apos;t load the skill collections.
							</p>
							<details className="text-detail text-muted-foreground">
								<summary className="cursor-pointer">Details</summary>
								<p className="mt-1 break-all">{skillPacksError}</p>
							</details>
						</div>
						{onRetrySkillPacks ? (
							<Button
								disabled={skillPacksLoading}
								onClick={onRetrySkillPacks}
								size="sm"
								variant="outline"
							>
								{skillPacksLoading ? "Loading…" : "Retry"}
							</Button>
						) : null}
					</div>
				) : null}

				{skillPacksCanConfigure ? null : (
					<p className="px-3 text-sm text-status-destructive" role="alert">
						Only a node owner or administrator can choose optional skills for
						this node.
					</p>
				)}

				{skillPacksLoading ? (
					<p className="px-3 py-2 text-muted-foreground text-sm">
						Loading recommended skills…
					</p>
				) : skillPacks.length > 0 ? (
					skillPacks.map((pack) => (
						<SkillPackRow
							disabled={disabled}
							isSelected={selectedSkillPackIds?.has(pack.id) ?? false}
							key={pack.id}
							onToggle={onToggleSkillPack}
							pack={pack}
						/>
					))
				) : skillPacksError ? null : (
					<p className="px-3 py-2 text-muted-foreground text-sm">
						No optional skill collections are available right now. Ryu&apos;s
						built-in skills are still ready to use.
					</p>
				)}
			</div>

			<OnboardingActions className="sticky bottom-0 justify-between bg-background py-2">
				<p
					className="px-3 text-muted-foreground/70 text-xs tabular-nums"
					data-testid="onboarding-skills-selected-count"
				>
					{tl("{selectedCount} of {total} selected", {
						selectedCount,
						total: skillPacks.length,
					})}
				</p>
				<OnboardingCta
					disabled={disabled}
					loading={skillPacksSubmitting}
					onClick={onContinueSkillPacks}
				>
					{skillPacksSubmitting
						? "Installing…"
						: selectedCount > 0
							? tl(
									"Install {selectedCount, plural, one {# pack} other {# packs}} & continue",
									{ selectedCount }
								)
							: "Continue with no optional packs"}
				</OnboardingCta>
			</OnboardingActions>
		</>
	);
}
