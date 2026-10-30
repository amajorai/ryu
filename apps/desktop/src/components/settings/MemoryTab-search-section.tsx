import { DatabaseIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	type ChangeEvent,
	type SubmitEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listSpaceSummaries,
	type ScoredChunk,
	type SpaceSummary,
	searchRetrieval,
} from "@/src/lib/api/retrieval.ts";
import { useMemoryOwner } from "./MemoryTab-owner.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

function sourceLabel(chunk: ScoredChunk, spaces: SpaceSummary[]): string {
	if (chunk.source === "memory") {
		return "Memory";
	}
	const space = spaces.find((s) => s.id === chunk.spaceId);
	return space ? `Space · ${space.name}` : "Space";
}

export function MemorySearchSection({ target }: { target: ApiTarget }) {
	const captureOwner = useMemoryOwner(target);
	const tl = useLiteralMessages();
	const [spaces, setSpaces] = useState<SpaceSummary[]>([]);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ScoredChunk[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	useLayoutEffect(() => {
		// Results and busy state belong to the selected authority; unsent text
		// and the mounted inputs remain with this editor.
		setResults(null);
		setSearching(false);
		setSearchError(null);
	}, [target]);

	// Load Space names once so retrieved chunks can be labelled with their origin.
	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		listSpaceSummaries(target)
			.then((list) => {
				if (!cancelled && isCurrent()) {
					setSpaces(list);
				}
			})
			.catch(() => {
				// Spaces are only used for labelling; a failure here is non-fatal.
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);

	const handleSearch = useCallback(
		async (e: SubmitEvent) => {
			e.preventDefault();
			const isCurrent = captureOwner();
			const trimmed = query.trim();
			if (!(isCurrent && trimmed)) {
				return;
			}
			setSearching(true);
			setSearchError(null);
			try {
				const chunks = await searchRetrieval(target, {
					query: trimmed,
					includeMemory: true,
				});
				if (isCurrent()) {
					setResults(chunks);
				}
			} catch {
				if (isCurrent()) {
					setSearchError("Couldn't search memory. Please try again.");
					setResults(null);
				}
			} finally {
				if (isCurrent()) {
					setSearching(false);
				}
			}
		},
		[query, target, captureOwner]
	);

	return (
		<SettingsSection
			caption="Run a similarity search across long-term memory and indexed Space documents. Results are ranked by relevance score."
			title="Search memory and Spaces"
		>
			<SettingsCard className="flex flex-col gap-3">
				<form className="flex gap-2" onSubmit={handleSearch}>
					<Input
						aria-label="Search query"
						onChange={(e: ChangeEvent<HTMLInputElement>) =>
							setQuery(e.target.value)
						}
						placeholder="What do you want to recall?"
						value={query}
					/>
					<Button disabled={!query.trim()} loading={searching} type="submit">
						{!searching && (
							<HugeiconsIcon className="size-4" icon={Search01Icon} />
						)}
						Search
					</Button>
				</form>

				{searchError ? (
					<p className="text-sm text-status-destructive">{searchError}</p>
				) : null}

				{results !== null && results.length === 0 && !searchError ? (
					<Empty spacing="compact">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={DatabaseIcon} />
							</EmptyMedia>
							<EmptyTitle>No matches found</EmptyTitle>
							<EmptyDescription>
								Nothing in memory or Spaces matched that query yet.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								onClick={() => {
									setQuery("");
									setResults(null);
									setSearchError(null);
								}}
								size="sm"
								variant="ghost"
							>
								Clear search
							</Button>
						</EmptyContent>
					</Empty>
				) : null}

				{results && results.length > 0 ? (
					<ul className="flex flex-col gap-2">
						{results.map((chunk) => (
							<li className="rounded-md bg-muted/40 p-3 text-sm" key={chunk.id}>
								<div className="mb-1.5 flex items-center justify-between gap-2">
									<Badge variant="secondary">
										{sourceLabel(chunk, spaces)}
									</Badge>
									<span className="font-mono text-muted-foreground text-xs">
										{tl("score {score}", { score: chunk.score.toFixed(3) })}
									</span>
								</div>
								<p className="whitespace-pre-wrap text-foreground">
									{chunk.content}
								</p>
							</li>
						))}
					</ul>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
