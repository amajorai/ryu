// apps/desktop/src/components/gateway/ModelsDefaultsCard.tsx
//
// Gateway › Defaults › Models: the node-wide coordinator and thread defaults.
// Stored as Core's `global` scope, which sits under every project and bot and
// above the lane default this section's other cards set, so a blank picker
// shows the lane model it falls back to.

import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { ModelDefaultsFields } from "@/src/components/chat/ModelDefaultsFields.tsx";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	clearScopeDefault,
	type DefaultsRole,
	type EffectiveDefaults,
	EMPTY_SCOPE_DEFAULT,
	fetchEffectiveDefaults,
	fetchScopeDefaults,
	GLOBAL_SCOPE,
	type ScopeDefault,
	setScopeDefault,
} from "@/src/lib/api/hierarchy.ts";
import {
	inheritedBelow,
	inheritedForCoordinator,
	isScopeSet,
} from "@/src/lib/model-defaults.ts";
import {
	NODE_DEFAULT_SCOPE_LABEL,
	scopeDefaultCacheWarning,
} from "@/src/lib/node-default-cache-warning.ts";

interface ModelsDefaultsProps {
	canConfigure: boolean;
	target: ApiTarget;
}

export function ModelsDefaultsCard(props: ModelsDefaultsProps) {
	const { url, token } = props.target;
	const userJwt = props.target.userJwt ?? null;
	const target = useMemo(
		() => ({ url, token, userJwt: userJwt ?? null }),
		[url, token, userJwt]
	);
	const instance = useId();
	const sequence = useRef(0);
	const scope = useMemo(
		() => `${instance}:${++sequence.current}`,
		[instance, url, token, userJwt]
	);
	return <ScopedModelsDefaultsCard key={scope} {...props} target={target} />;
}

function ScopedModelsDefaultsCard({
	canConfigure,
	target,
}: ModelsDefaultsProps) {
	const [stored, setStored] = useState<ScopeDefault>(EMPTY_SCOPE_DEFAULT);
	const [draft, setDraft] = useState<ScopeDefault>(EMPTY_SCOPE_DEFAULT);
	const [effective, setEffective] = useState<
		Record<DefaultsRole, EffectiveDefaults | null>
	>({ coordinator: null, thread: null });
	const [loaded, setLoaded] = useState(false);
	// The stored record failed to load. Editing stays blocked until it loads:
	// a save writes every field, so an empty draft would replace the defaults
	// the user cannot see.
	const [loadFailed, setLoadFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	// A model change held until the user confirms the cache reset it causes.
	const [pendingChange, setPendingChange] = useState<{
		apply: () => void;
		confirmation: PromptCacheConfirmation;
	} | null>(null);
	// Only the newest load may commit: after a node switch, a slow response
	// from the previous node must never land in the form, or the next save
	// would copy that node's defaults onto this one.
	const loadSeq = useRef(0);
	const pendingWrite = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			loadSeq.current++;
		};
	}, []);

	const load = useCallback(async () => {
		const seq = ++loadSeq.current;
		const [all, coordinator, thread] = await Promise.allSettled([
			fetchScopeDefaults(target),
			fetchEffectiveDefaults(target, {
				inheritedOnly: true,
				role: "coordinator",
			}),
			fetchEffectiveDefaults(target, { inheritedOnly: true, role: "thread" }),
		]);
		if (!mounted.current || seq !== loadSeq.current) {
			return;
		}
		if (all.status === "fulfilled") {
			const current = all.value[GLOBAL_SCOPE] ?? EMPTY_SCOPE_DEFAULT;
			setStored(current);
			setDraft(current);
			setLoadFailed(false);
		} else {
			setLoadFailed(true);
		}
		// The inherited labels are optional: without them the pickers just show
		// no fallback hint.
		setEffective({
			coordinator:
				coordinator.status === "fulfilled" ? coordinator.value : null,
			thread: thread.status === "fulfilled" ? thread.value : null,
		});
		setLoaded(true);
	}, [target]);

	useEffect(() => {
		setLoaded(false);
		setLoadFailed(false);
		void load();
	}, [load]);

	const run = async (write: () => Promise<void>) => {
		if (!(canConfigure && loaded) || loadFailed || pendingWrite.current) {
			return;
		}
		pendingWrite.current = true;
		setBusy(true);
		try {
			await write();
			if (mounted.current) {
				await load();
			}
		} catch {
			if (!mounted.current) {
				return;
			}
			toast.error("Couldn't save the model defaults", {
				description: "Check your connection and try again.",
			});
		} finally {
			pendingWrite.current = false;
			if (mounted.current) {
				setBusy(false);
			}
		}
	};

	/** Write `next` now when it keeps every model, or after "Apply now" when it
	 * moves the thread or coordinator model of every chat without a closer
	 * default. Cancel writes nothing. */
	const confirmThenRun = (next: ScopeDefault, write: () => Promise<void>) => {
		const confirmation = scopeDefaultCacheWarning(
			NODE_DEFAULT_SCOPE_LABEL,
			stored,
			next
		);
		if (!confirmation) {
			void run(write);
			return;
		}
		setPendingChange({ apply: () => void run(write), confirmation });
	};

	const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Projects, bots and groups talk to you through a main thread that coordinates the work, and each piece of work runs in its own session. Set the models they use everywhere on this node. A project or bot can override these from a thread's Defaults menu."
					}
				>
					{"The models main threads and work sessions use on this node."}
				</CaptionInfo>
			}
			headerAction={
				canConfigure && loaded && !loadFailed ? (
					<div className="flex gap-1">
						{isScopeSet(stored) ? (
							<Button
								disabled={busy}
								onClick={() =>
									confirmThenRun(EMPTY_SCOPE_DEFAULT, () =>
										clearScopeDefault(target, GLOBAL_SCOPE)
									)
								}
								size="sm"
								variant="ghost"
							>
								Reset to defaults
							</Button>
						) : null}
						<Button
							disabled={busy || !dirty}
							onClick={() =>
								confirmThenRun(draft, () =>
									setScopeDefault(target, GLOBAL_SCOPE, draft)
								)
							}
							size="sm"
							variant="outline"
						>
							Save
						</Button>
					</div>
				) : null
			}
			title="Models"
		>
			<SettingsCard className="space-y-4">
				{loaded && loadFailed ? (
					<div className="flex items-center justify-between gap-2">
						<p className="text-muted-foreground text-sm">
							Couldn't load the current model defaults.
						</p>
						<Button onClick={() => void load()} size="sm" variant="outline">
							Retry
						</Button>
					</div>
				) : null}
				{loaded && !loadFailed ? (
					<ModelDefaultsFields
						disabled={!canConfigure || busy}
						inherited={{
							coordinator: inheritedForCoordinator(
								effective.coordinator?.levels,
								"settings",
								stored
							),
							thread: inheritedBelow(effective.thread?.levels, "settings"),
						}}
						onChange={setDraft}
						target={target}
						value={draft}
					/>
				) : null}
				{loaded ? null : <Skeleton className="h-40 w-full" />}
				<PromptCacheConfirmDialog
					confirmation={pendingChange?.confirmation ?? null}
					onApply={() => {
						const change = pendingChange;
						setPendingChange(null);
						change?.apply();
					}}
					onCancel={() => setPendingChange(null)}
				/>
			</SettingsCard>
			{canConfigure ? null : (
				<p className="px-3 text-muted-foreground text-xs leading-snug">
					Only organization owners and admins can change the node's model
					defaults.
				</p>
			)}
		</SettingsSection>
	);
}
