import {
	Add01Icon,
	DatabaseIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getAutoRecallEnabled,
	getSkillsProgressive,
	setAutoRecallEnabled,
	setSkillsProgressive,
} from "@/src/lib/api/preferences.ts";
import {
	indexChunk,
	listSpaceSummaries,
	type ScoredChunk,
	type SpaceSummary,
	searchRetrieval,
} from "@/src/lib/api/retrieval.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Shared with ChatPage so the long-term memory opt-in is one setting, not two.
const LONG_TERM_MEMORY_KEY = "ryu_long_term_memory";

function sourceLabel(chunk: ScoredChunk, spaces: SpaceSummary[]): string {
	if (chunk.source === "memory") {
		return "Memory";
	}
	const space = spaces.find((s) => s.id === chunk.spaceId);
	return space ? `Space · ${space.name}` : "Space";
}

export function MemoryTab() {
	const activeNode = useActiveNode();
	// Memoize so this object is stable across renders — the data-loading effects
	// depend on it and would otherwise re-fire on every keystroke.
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
		}),
		[activeNode.url, activeNode.token]
	);

	// Long-term (cross-session) memory is opt-in per the privacy-by-default
	// principle. Persisted in the same localStorage key the chat transport reads,
	// so toggling it here changes what chat recalls and survives restarts.
	const [longTermMemory, setLongTermMemory] = useState<boolean>(
		() => localStorage.getItem(LONG_TERM_MEMORY_KEY) === "true"
	);
	const handleLongTermChange = useCallback((next: boolean) => {
		setLongTermMemory(next);
		localStorage.setItem(LONG_TERM_MEMORY_KEY, String(next));
	}, []);

	// Auto-recall (U17): before each chat turn Core retrieves relevant memory +
	// past chat messages and injects them into the prompt. Default ON; persisted in
	// Core under the `auto-recall-enabled` pref so it applies on every node-served
	// chat turn (not just this client).
	const [autoRecall, setAutoRecall] = useState<boolean>(true);
	useEffect(() => {
		let cancelled = false;
		getAutoRecallEnabled(target).then((value) => {
			if (!cancelled) {
				setAutoRecall(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target]);
	const handleAutoRecallChange = useCallback(
		(next: boolean) => {
			setAutoRecall(next);
			setAutoRecallEnabled(target, next).catch(() => undefined);
		},
		[target]
	);

	// Skills disclosure: progressive (default) injects only an L1 skill index and
	// loads full bodies on demand via the `skills__load` tool, saving context on
	// low-context models; full injects every enabled skill body each turn.
	const [skillsProgressive, setSkillsProgressiveState] =
		useState<boolean>(true);
	useEffect(() => {
		let cancelled = false;
		getSkillsProgressive(target).then((value) => {
			if (!cancelled) {
				setSkillsProgressiveState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target]);
	const handleSkillsProgressiveChange = useCallback(
		(next: boolean) => {
			setSkillsProgressiveState(next);
			setSkillsProgressive(target, next).catch(() => undefined);
		},
		[target]
	);

	const [spaces, setSpaces] = useState<SpaceSummary[]>([]);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ScoredChunk[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);

	const [indexContent, setIndexContent] = useState("");
	const [indexing, setIndexing] = useState(false);
	const [indexStatus, setIndexStatus] = useState<string | null>(null);
	const [indexError, setIndexError] = useState<string | null>(null);

	// Load Space names once so retrieved chunks can be labelled with their origin.
	useEffect(() => {
		let cancelled = false;
		listSpaceSummaries(target)
			.then((list) => {
				if (!cancelled) {
					setSpaces(list);
				}
			})
			.catch(() => {
				// Spaces are only used for labelling; a failure here is non-fatal.
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleSearch = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			const trimmed = query.trim();
			if (!trimmed) {
				return;
			}
			setSearching(true);
			setSearchError(null);
			try {
				const chunks = await searchRetrieval(target, {
					query: trimmed,
					includeMemory: true,
				});
				setResults(chunks);
			} catch {
				setSearchError("Couldn't search memory. Please try again.");
				setResults(null);
			} finally {
				setSearching(false);
			}
		},
		[query, target]
	);

	const handleIndex = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			const trimmed = indexContent.trim();
			if (!trimmed) {
				return;
			}
			setIndexing(true);
			setIndexStatus(null);
			setIndexError(null);
			try {
				await indexChunk(target, {
					id: `manual-${Date.now()}`,
					content: trimmed,
					source: "memory",
				});
				setIndexStatus("Saved to memory.");
				setIndexContent("");
			} catch {
				setIndexError("Couldn't save that to memory. Please try again.");
			} finally {
				setIndexing(false);
			}
		},
		[indexContent, target]
	);

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Off by default. When on, Ryu remembers durable facts across conversations and recalls them in future chats. This choice is shared with the chat view and persists across restarts."
				title="Long-term memory"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={longTermMemory}
								id="long-term-memory"
								onCheckedChange={handleLongTermChange}
							/>
						}
						title="Remember facts across conversations"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default. Before each reply, Ryu finds relevant snippets from your long-term memory and past conversations and gives them to the model as background context. It never blocks a reply if this is unavailable, and it skips the current conversation."
				title="Auto-recall"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={autoRecall}
								id="auto-recall"
								onCheckedChange={handleAutoRecallChange}
							/>
						}
						title="Automatically recall relevant context"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default. Instead of giving the model every enabled skill's full instructions on every reply, Ryu shares a short list and the agent loads a skill's full instructions on demand when relevant — saving context on smaller local models. Only agents that run tools (the default Ryu agent) load on demand; others always get full instructions. Turn off to always include full skill instructions."
				title="Skill loading"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={skillsProgressive}
								id="skills-progressive"
								onCheckedChange={handleSkillsProgressiveChange}
							/>
						}
						title="Load skills on demand"
					/>
				</SettingsGroup>
			</SettingsSection>

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
						<Button disabled={searching || !query.trim()} type="submit">
							{searching ? (
								<Spinner />
							) : (
								<HugeiconsIcon className="size-4" icon={Search01Icon} />
							)}
							Search
						</Button>
					</form>

					{searchError ? (
						<p className="text-destructive text-sm">{searchError}</p>
					) : null}

					{results !== null && results.length === 0 && !searchError ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={DatabaseIcon} />
								</EmptyMedia>
								<EmptyTitle>No matches found</EmptyTitle>
								<EmptyDescription>
									Nothing in memory or Spaces matched that query yet.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : null}

					{results && results.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{results.map((chunk) => (
								<li
									className="rounded-md bg-muted/40 p-3 text-sm"
									key={chunk.id}
								>
									<div className="mb-1.5 flex items-center justify-between gap-2">
										<Badge variant="secondary">
											{sourceLabel(chunk, spaces)}
										</Badge>
										<span className="font-mono text-muted-foreground text-xs">
											score {chunk.score.toFixed(3)}
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

			<SettingsSection
				caption="Manually add a piece of text to long-term memory so Ryu can recall it later."
				title="Add to memory"
			>
				<SettingsCard>
					<form className="flex flex-col gap-3" onSubmit={handleIndex}>
						<Textarea
							aria-label="Text to remember"
							onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
								setIndexContent(e.target.value)
							}
							placeholder="Text to remember…"
							rows={3}
							value={indexContent}
						/>
						{indexStatus ? (
							<p className="text-muted-foreground text-sm">{indexStatus}</p>
						) : null}
						{indexError ? (
							<p className="text-destructive text-sm">{indexError}</p>
						) : null}
						<div className="flex justify-end">
							<Button disabled={indexing || !indexContent.trim()} type="submit">
								{indexing ? (
									<Spinner />
								) : (
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
								)}
								Add to memory
							</Button>
						</div>
					</form>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
