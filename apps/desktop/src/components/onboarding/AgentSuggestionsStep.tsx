import { Button } from "@ryu/ui/components/button";
import { Check, ChevronDown, Sparkles, Wrench } from "lucide-react";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { OnboardingAgentSuggestion } from "@/src/lib/api/onboarding-profile.ts";

const TOOL_LABELS: Record<string, string> = {
	"memory.search": "Memory search",
	"memory.store": "Save memories",
	"routines.create": "Create routines",
	"routines.list": "View routines",
	"search_conversations.search": "Search past chats",
	"skills.load": "Load skills",
	"skills.search": "Search skills",
	"spaces.list_documents": "List Space documents",
	"spaces.search": "Search Spaces",
	"web.crawl": "Crawl the web",
	"web.extract": "Read web pages",
	"web.search": "Search the web",
	"workspace.open_panel": "Open a Ryu panel",
	"workspace.open_tab": "Open a Ryu page",
};

function toolLabel(tool: string): string {
	return (
		TOOL_LABELS[tool] ??
		tool
			.split(".")
			.at(-1)
			?.replaceAll("_", " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase()) ??
		tool
	);
}

function SuggestionCard({
	disabled,
	onToggle,
	selected,
	suggestion,
}: {
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
					className="flex w-full items-start gap-3 text-left"
					disabled={disabled}
					onClick={onToggle}
					type="button"
				>
					<span
						className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}
					>
						{selected ? <Check className="size-3.5" /> : null}
					</span>
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-2">
							<span className="font-semibold text-sm">{suggestion.name}</span>
							<span className="rounded-full bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
								{suggestion.title}
							</span>
						</span>
						<span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
							{suggestion.description}
						</span>
					</span>
				</button>

				<div className="mt-3 ml-8 flex flex-col gap-3">
					<div className="rounded-lg bg-background/50 px-3 py-2">
						<div className="flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
							<Sparkles className="size-3" />
							Why this showed up
						</div>
						<p className="mt-1 text-xs leading-relaxed">{suggestion.reason}</p>
					</div>

					<div className="flex items-start gap-2">
						<Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
						<div
							className="flex min-w-0 flex-wrap gap-1.5"
							data-testid="suggested-tools"
						>
							{suggestion.tools.map((tool) => (
								<span
									className="rounded-full border border-border/70 bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
									key={tool}
								>
									{toolLabel(tool)}
								</span>
							))}
						</div>
					</div>

					<details className="group rounded-lg border border-border/60 bg-background/40">
						<summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-muted-foreground text-xs [&::-webkit-details-marker]:hidden">
							<span>View prompt setup</span>
							<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
						</summary>
						<p
							className="whitespace-pre-wrap border-border/60 border-t px-3 py-2 text-muted-foreground text-xs leading-relaxed"
							data-testid="suggested-prompt"
						>
							{suggestion.systemPrompt}
						</p>
					</details>
				</div>
			</SettingsCard>
		</div>
	);
}

export function AgentSuggestionsStep({
	busy,
	error,
	onCreate,
	onSkip,
	onToggle,
	selected,
	suggestions,
}: {
	busy: boolean;
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
			<SettingsCard className="flex flex-col gap-2">
				<div className="flex items-center gap-2 font-medium text-sm">
					<Sparkles className="size-4 text-primary" />
					Drafts from your work patterns
				</div>
				<p className="text-muted-foreground text-xs leading-relaxed">
					Ryu noticed repeated workflows in the sources you approved. Review
					each recipe, then select the ones you want to add. Nothing is created
					until you confirm.
				</p>
			</SettingsCard>

			<div className="flex flex-col gap-3">
				{suggestions.map((suggestion) => (
					<SuggestionCard
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
