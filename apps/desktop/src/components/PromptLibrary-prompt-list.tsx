// apps/desktop/src/components/PromptLibrary-prompt-list.tsx
//
// The prompt picker list of the prompt library: one button per prompt with its
// type, source, and label badges.

import { Badge } from "@ryu/ui/components/badge.tsx";
import type { PromptSummary } from "@/src/lib/api/prompts.ts";
import { labelEntries } from "@/src/lib/prompt-library.ts";

export interface PromptLibraryPromptListProps {
	prompts: PromptSummary[];
	selectedName: string | null;
	setSelectedName: (name: string) => void;
}

export function PromptLibraryPromptList({
	prompts,
	selectedName,
	setSelectedName,
}: PromptLibraryPromptListProps) {
	return (
		<ul className="flex flex-col gap-1">
			{prompts.map((prompt) => (
				<li key={prompt.name}>
					<button
						aria-pressed={prompt.name === selectedName}
						className="flex w-full flex-col gap-1 rounded-md border p-2 text-left hover:bg-muted/50 aria-pressed:border-primary"
						onClick={() => setSelectedName(prompt.name)}
						type="button"
					>
						<span className="flex items-center gap-2">
							<span className="truncate font-medium text-xs">
								{prompt.name}
							</span>
							<Badge size="compact" variant="outline">
								{prompt.type}
							</Badge>
							{prompt.source === "cloud" ? (
								<Badge size="compact" tint="blue">
									Organization
								</Badge>
							) : null}
						</span>
						<span className="flex flex-wrap gap-1">
							{labelEntries(prompt).map(({ label, version }) => (
								<Badge key={label} size="compact" variant="secondary">
									{label} · v{version}
								</Badge>
							))}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}
