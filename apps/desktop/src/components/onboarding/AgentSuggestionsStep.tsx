import { Button } from "@ryu/ui/components/button";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { Check } from "lucide-react";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { OnboardingAgentSuggestion } from "@/src/lib/api/onboarding-profile.ts";

function SuggestionCard({
	connectedApps,
	disabled,
	onToggle,
	selected,
	suggestion,
}: {
	connectedApps: readonly string[];
	disabled: boolean;
	onToggle: () => void;
	selected: boolean;
	suggestion: OnboardingAgentSuggestion;
}) {
	return (
		<div data-testid={`agent-suggestion-${suggestion.id}`}>
			<SettingsCard
				className={
					selected ? "bg-primary/10 ring-1 ring-primary/30" : undefined
				}
			>
				<button
					aria-label={`${selected ? "Deselect" : "Select"} ${suggestion.name}`}
					aria-pressed={selected}
					className="flex w-full items-center gap-3 text-left"
					disabled={disabled}
					onClick={onToggle}
					type="button"
				>
					<span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted">
						<DitherAvatar
							animate={false}
							className="size-full"
							name={`onboarding:${suggestion.id}`}
						/>
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate font-semibold text-sm">
							{suggestion.name}
						</span>
						<span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
							{suggestion.description}
						</span>
					</span>
					<span
						className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}
					>
						{selected ? <Check className="size-3.5" /> : null}
					</span>
				</button>

				{connectedApps.length > 0 ? (
					<div className="mt-3 ml-14 flex flex-wrap items-center gap-1.5">
						<span className="mr-1 text-[11px] text-muted-foreground">
							Connected apps
						</span>
						{connectedApps.map((app) => (
							<span
								className="rounded-full border border-border/70 bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
								key={app}
							>
								{app}
							</span>
						))}
					</div>
				) : null}
			</SettingsCard>
		</div>
	);
}

export function AgentSuggestionsStep({
	busy,
	connectedApps,
	error,
	onCreate,
	onSkip,
	onToggle,
	selected,
	suggestions,
}: {
	busy: boolean;
	connectedApps: readonly string[];
	error?: string | null;
	onCreate: () => void;
	onSkip: () => void;
	onToggle: (id: string) => void;
	selected: ReadonlySet<string>;
	suggestions: readonly OnboardingAgentSuggestion[];
}) {
	const selectedCount = selected.size;
	return (
		<div className="flex w-full max-w-xl flex-col gap-3 pb-4">
			<div className="flex flex-col gap-3">
				{suggestions.map((suggestion) => (
					<SuggestionCard
						connectedApps={connectedApps}
						disabled={busy}
						key={suggestion.id}
						onToggle={() => onToggle(suggestion.id)}
						selected={selected.has(suggestion.id)}
						suggestion={suggestion}
					/>
				))}
			</div>

			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}

			<div className="sticky bottom-0 flex items-center justify-between gap-3 bg-background/80 py-2 backdrop-blur-sm">
				<Button disabled={busy} onClick={onSkip} variant="ghost">
					Skip for now
				</Button>
				<Button
					disabled={selectedCount === 0 || busy}
					loading={busy}
					onClick={onCreate}
					size="lg"
					variant="mono"
				>
					{selectedCount > 0
						? `Add ${selectedCount} agent${selectedCount === 1 ? "" : "s"}`
						: "Select an agent"}
				</Button>
			</div>
		</div>
	);
}
