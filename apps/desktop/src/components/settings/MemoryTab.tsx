import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type ChangeEvent,
	type SubmitEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createMemory,
	getMemorySettings,
	setMemorySettings,
} from "@/src/lib/api/memory.ts";
import {
	AUTO_RECALL_DEFAULT_TOP_K,
	AUTO_RECALL_MAX_TOP_K,
	AUTO_RECALL_MIN_TOP_K,
	getAutoRecallEnabled,
	getAutoRecallTopK,
	getSkillsProgressive,
	setAutoRecallEnabled,
	setAutoRecallTopK,
	setSkillsProgressive,
} from "@/src/lib/api/preferences.ts";
import { ContextWindowSection } from "./MemoryTab-context-window.tsx";
import {
	ContextHandoffSection,
	ToolRankerSection,
} from "./MemoryTab-handoff-ranker.tsx";
import { persist, useMemoryOwner } from "./MemoryTab-owner.ts";
import { MemorySearchSection } from "./MemoryTab-search-section.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Shared with ChatPage so the long-term memory opt-in is one setting, not two.
const LONG_TERM_MEMORY_KEY = "ryu_long_term_memory";

export function MemoryTab() {
	const activeNode = useActiveNode();
	// Memoize so this object is stable across renders — the data-loading effects
	// depend on it and would otherwise re-fire on every keystroke.
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const captureOwner = useMemoryOwner(target);
	const tl = useLiteralMessages();

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

	// Sensitive-topic consent is stored by Core per user/node, not in
	// localStorage or the node-global preference table. Core defaults it off and
	// applies it to capture, recall, search, and graph snapshots.
	const [includeSensitiveTopics, setIncludeSensitiveTopics] = useState(false);
	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		setIncludeSensitiveTopics(false);
		getMemorySettings(target)
			.then((settings) => {
				if (!cancelled && isCurrent()) {
					setIncludeSensitiveTopics(settings.includeSensitiveTopics);
				}
			})
			.catch(() => {
				// Unavailable or unauthenticated nodes fail closed to off.
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);
	const handleSensitiveTopicsChange = useCallback(
		(next: boolean) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = includeSensitiveTopics;
			setIncludeSensitiveTopics(next);
			setMemorySettings(target, { includeSensitiveTopics: next }).catch(() => {
				if (!isCurrent()) {
					return;
				}
				setIncludeSensitiveTopics(previous);
				toast.error({
					title: "Couldn't save sensitive-memory consent",
					description: "Your change wasn't saved. Please try again.",
				});
			});
		},
		[target, captureOwner, includeSensitiveTopics]
	);

	// Auto-recall (U17): before each chat turn Core retrieves relevant memory +
	// past chat messages and injects them into the prompt. Default ON; persisted in
	// Core under the `auto-recall-enabled` pref so it applies on every node-served
	// chat turn (not just this client).
	const [autoRecall, setAutoRecall] = useState<boolean>(true);
	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		getAutoRecallEnabled(target)
			.then((value) => {
				if (!cancelled && isCurrent()) {
					setAutoRecall(value);
				}
			})
			.catch(() => {
				if (!cancelled && isCurrent()) {
					setAutoRecall(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);
	const handleAutoRecallChange = useCallback(
		(next: boolean) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = autoRecall;
			setAutoRecall(next);
			persist(
				setAutoRecallEnabled(target, next),
				isCurrent,
				"auto-recall",
				() => setAutoRecall(previous)
			);
		},
		[autoRecall, target, captureOwner]
	);

	// How many recalled snippets are injected per turn (`auto-recall-top-k`).
	// Kept as text while editing and clamped on blur, like the context inputs.
	// The displayed number is what this control WRITES: Core reads the pref
	// first but falls back to `RYU_AUTO_RECALL_TOP_K` when the pref is unset,
	// and the desktop cannot see the node's environment.
	const [topKText, setTopKText] = useState("");
	// The value currently stored on the node, so a blur that changed nothing can
	// be told apart from an edit. Core accepts any positive integer here, so a
	// stored value can legitimately sit above the range this control offers.
	const [topKSaved, setTopKSaved] = useState<number | null>(null);
	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		getAutoRecallTopK(target)
			.then((value) => {
				if (!cancelled && isCurrent()) {
					setTopKSaved(value);
					setTopKText(String(value));
				}
			})
			.catch(() => {
				if (!cancelled && isCurrent()) {
					setTopKSaved(AUTO_RECALL_DEFAULT_TOP_K);
					setTopKText(String(AUTO_RECALL_DEFAULT_TOP_K));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);
	const commitTopK = useCallback(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		const parsed = Number.parseInt(topKText.trim(), 10);
		if (!Number.isFinite(parsed)) {
			setTopKText(topKSaved === null ? "" : String(topKSaved));
			return;
		}
		if (parsed === topKSaved) {
			setTopKText(String(parsed));
			return;
		}
		const clamped = Math.min(
			Math.max(parsed, AUTO_RECALL_MIN_TOP_K),
			AUTO_RECALL_MAX_TOP_K
		);
		const previous = topKSaved;
		setTopKSaved(clamped);
		setTopKText(String(clamped));
		persist(
			setAutoRecallTopK(target, clamped),
			isCurrent,
			"the recall limit",
			() => {
				setTopKSaved(previous);
				setTopKText(previous === null ? "" : String(previous));
			}
		);
	}, [target, topKSaved, topKText, captureOwner]);

	// Skills disclosure: progressive (default) injects only an L1 skill index and
	// loads full bodies on demand via the `skills.load` tool, saving context on
	// low-context models; full injects every enabled skill body each turn.
	const [skillsProgressive, setSkillsProgressiveState] =
		useState<boolean>(true);
	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		getSkillsProgressive(target)
			.then((value) => {
				if (!cancelled && isCurrent()) {
					setSkillsProgressiveState(value);
				}
			})
			.catch(() => {
				if (!cancelled && isCurrent()) {
					setSkillsProgressiveState(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);
	const handleSkillsProgressiveChange = useCallback(
		(next: boolean) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = skillsProgressive;
			setSkillsProgressiveState(next);
			persist(
				setSkillsProgressive(target, next),
				isCurrent,
				"skill loading",
				() => setSkillsProgressiveState(previous)
			);
		},
		[skillsProgressive, target, captureOwner]
	);

	const [indexContent, setIndexContent] = useState("");
	const [indexing, setIndexing] = useState(false);
	const [indexStatus, setIndexStatus] = useState<string | null>(null);
	const [indexError, setIndexError] = useState<string | null>(null);
	useLayoutEffect(() => {
		// Busy state and status belong to the selected authority; unsent text
		// and the mounted inputs remain with this editor.
		setIndexing(false);
		setIndexStatus(null);
		setIndexError(null);
	}, [target]);

	const handleIndex = useCallback(
		async (e: SubmitEvent) => {
			e.preventDefault();
			const isCurrent = captureOwner();
			const trimmed = indexContent.trim();
			if (!(isCurrent && trimmed)) {
				return;
			}
			setIndexing(true);
			setIndexStatus(null);
			setIndexError(null);
			try {
				await createMemory(target, { content: trimmed });
				if (isCurrent()) {
					setIndexStatus("Saved to memory.");
					setIndexContent("");
				}
			} catch {
				if (isCurrent()) {
					setIndexError("Couldn't save that to memory. Please try again.");
				}
			} finally {
				if (isCurrent()) {
					setIndexing(false);
				}
			}
		},
		[indexContent, target, captureOwner]
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
								aria-label="Remember facts across conversations"
								checked={longTermMemory}
								id="long-term-memory"
								onCheckedChange={handleLongTermChange}
							/>
						}
						title="Remember facts across conversations"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Include sensitive topics in memory"
								checked={includeSensitiveTopics}
								id="include-sensitive-topics"
								onCheckedChange={handleSensitiveTopicsChange}
							/>
						}
						description="Allows Ryu to capture and recall sensitive topics such as health conditions and religious beliefs. Off by default; existing sensitive memories stay hidden while it is off."
						title="Include sensitive topics in memory"
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
								aria-label="Automatically recall relevant context"
								checked={autoRecall}
								id="auto-recall"
								onCheckedChange={handleAutoRecallChange}
							/>
						}
						title="Automatically recall relevant context"
					/>
					<SettingsItem
						actions={
							<Input
								aria-label="Snippets recalled per reply"
								className="h-8 w-20 text-right"
								// Nothing is recalled at all while the switch above is off, so
								// this limit would be a number that cannot take effect.
								disabled={!autoRecall}
								inputMode="numeric"
								onBlur={commitTopK}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setTopKText(e.target.value)
								}
								value={topKText}
							/>
						}
						description={tl(
							"How many snippets from memory and past chats are added to a reply. Lower this if replies feel cluttered with old context; raise it for better recall on long-running work. This control writes {min}–{max}; a larger number set outside the app is shown as-is and left alone until you change it.",
							{ min: AUTO_RECALL_MIN_TOP_K, max: AUTO_RECALL_MAX_TOP_K }
						)}
						title="Snippets per reply"
					/>
				</SettingsGroup>
			</SettingsSection>

			<ContextWindowSection target={target} />

			<ContextHandoffSection target={target} />

			<SettingsSection
				caption="On by default. Instead of giving the model every enabled skill's full instructions on every reply, Ryu shares a short list and the agent loads a skill's full instructions on demand when relevant, which saves context on smaller local models. Only agents that run tools (the default Ryu agent) load on demand; others always get full instructions. Turn off to always include full skill instructions."
				title="Skill loading"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Load skills on demand"
								checked={skillsProgressive}
								id="skills-progressive"
								onCheckedChange={handleSkillsProgressiveChange}
							/>
						}
						title="Load skills on demand"
					/>
				</SettingsGroup>
			</SettingsSection>

			<ToolRankerSection target={target} />

			<MemorySearchSection target={target} />

			<SettingsSection
				caption="Manually add a piece of text to long-term memory so Ryu can recall it later."
				title="Add to memory"
			>
				{/* `bare`: what the card holds is one tall textarea plus its OWN status
				    line and submit button — not sibling settings — so the surface only
				    draws a second edge around the textarea's border. */}
				<SettingsCard bare>
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
							<p className="text-sm text-status-destructive">{indexError}</p>
						) : null}
						<div className="flex justify-end">
							<Button
								disabled={!indexContent.trim()}
								loading={indexing}
								type="submit"
							>
								{!indexing && (
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
