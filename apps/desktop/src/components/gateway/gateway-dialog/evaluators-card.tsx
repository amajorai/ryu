import {
	EvaluatorCatalog,
	type EvaluatorCatalogItem,
} from "@ryu/blocks/desktop/evaluator-catalog.tsx";
import {
	LockedByBroader,
	LockToggle,
	PipelineBadge,
} from "@ryu/blocks/desktop/guardrails/controls.tsx";
import {
	GUARDRAIL_ACTION_LABELS as POLICY_LABELS,
	GUARDRAIL_ACTION_OPTIONS as POLICY_OPTIONS,
} from "@ryu/blocks/desktop/guardrails/copy.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useState } from "react";
import { toCatalogItem } from "@/src/components/evaluators/catalog-utils.ts";
import {
	EvaluatorEditorDialog,
	type EvaluatorEditorMode,
} from "@/src/components/evaluators/EvaluatorEditorDialog.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { Evaluator, EvaluatorBinding } from "@/src/lib/api/gateway.ts";
import {
	deleteCustomEvaluator,
	fetchEvaluators,
} from "@/src/lib/api/gateway.ts";
import type { ScopeCtx } from "./inspector-card.tsx";

// ── Evaluators card (inline guardrail surface) ────────────────────────────────
//
// The shared evaluator catalog, filtered to inline-capable entries. Enabling an
// evaluator writes an `EvaluatorBinding` into the current scope's firewall
// config (`ctx.node.evaluators` / the overlay's `evaluators`), so it persists
// through the same "Save guardrails" PUT as the firewall dials — no separate
// save. A binding a broader scope locked renders read-only (cannot loosen).
// Create-from-scratch launches the shared editor dialog; that path DOES restart
// the gateway (custom evaluators are a startup snapshot), so the catalog reloads
// after a save.

function evalBindingFor(
	bindings: EvaluatorBinding[],
	id: string
): EvaluatorBinding | undefined {
	return bindings.find((b) => b.id === id);
}

export function EvaluatorsCard({
	target,
	ctx,
	pipelineStages,
}: {
	target: ApiTarget;
	ctx: ScopeCtx;
	pipelineStages?: string[];
}) {
	const tl = useLiteralMessages();
	const [catalog, setCatalog] = useState<Evaluator[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [editorMode, setEditorMode] = useState<EvaluatorEditorMode | null>(
		null
	);
	const [reloadKey, setReloadKey] = useState(0);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		fetchEvaluators(target)
			.then((list) => {
				if (!cancelled) {
					setCatalog(list);
					setError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setError(
						e instanceof Error ? e.message : "Failed to load evaluator catalog"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, reloadKey]);

	const byId = useMemo(() => new Map(catalog.map((e) => [e.id, e])), [catalog]);
	const items = useMemo(() => catalog.map(toCatalogItem), [catalog]);
	const customSet = useMemo(() => catalog.filter((e) => !e.builtin), [catalog]);
	const allIds = useMemo(() => catalog.map((e) => e.id), [catalog]);

	const bindings: EvaluatorBinding[] = ctx.isOverlay
		? (ctx.overlay.evaluators ?? [])
		: (ctx.node.evaluators ?? []);

	const setBindings = (next: EvaluatorBinding[]) => {
		if (ctx.isOverlay) {
			ctx.setOverlayField({ evaluators: next });
		} else {
			ctx.setNodeField({ evaluators: next });
		}
	};

	// Node bindings that a narrower (overlay) scope sees as locked-by-broader.
	const broaderLocked = useMemo(() => {
		const m = new Map<string, EvaluatorBinding>();
		if (ctx.isOverlay) {
			for (const b of ctx.node.evaluators ?? []) {
				if (b.locked) {
					m.set(b.id, b);
				}
			}
		}
		return m;
	}, [ctx.isOverlay, ctx.node.evaluators]);

	const upsert = (id: string, patch: Partial<EvaluatorBinding>) => {
		const existing = evalBindingFor(bindings, id);
		const base: EvaluatorBinding = existing ?? {
			id,
			enabled: false,
			inlineAction: byId.get(id)?.inline?.action ?? "warn_and_continue",
			locked: false,
		};
		const next = bindings.filter((b) => b.id !== id);
		next.push({ ...base, ...patch });
		setBindings(next);
	};

	const handleDeleteCustom = async (id: string) => {
		setDeletingId(id);
		try {
			await deleteCustomEvaluator(target, id, customSet);
			setReloadKey((k) => k + 1);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to delete evaluator");
		} finally {
			setDeletingId(null);
		}
	};

	const renderControl = (item: EvaluatorCatalogItem) => {
		const locked = broaderLocked.get(item.id);
		if (locked) {
			const label = POLICY_LABELS[locked.inlineAction ?? "warn_and_continue"];
			return <LockedByBroader summary={tl("Locked ({label})", { label })} />;
		}
		const binding = evalBindingFor(bindings, item.id);
		const enabled = binding?.enabled ?? false;
		const action =
			binding?.inlineAction ??
			byId.get(item.id)?.inline?.action ??
			"warn_and_continue";
		return (
			<div className="flex items-center gap-1.5">
				{enabled ? (
					<Select
						disabled={ctx.disabled}
						items={POLICY_OPTIONS}
						onValueChange={(v) =>
							upsert(item.id, {
								inlineAction: v ?? "warn_and_continue",
							})
						}
						value={action}
					>
						<SelectTrigger
							appearance="gateway-action"
							aria-label={tl("{name} action", { name: item.name })}
							className="w-28"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{POLICY_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{POLICY_LABELS[opt.value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
				<Switch
					aria-label={tl("Enable {name}", { name: item.name })}
					checked={enabled}
					disabled={ctx.disabled || deletingId === item.id}
					onCheckedChange={(c: boolean) =>
						upsert(item.id, { enabled: c, inlineAction: action })
					}
				/>
				{ctx.isOverlay || !enabled ? null : (
					<LockToggle
						disabled={ctx.disabled}
						fieldLabel={item.name}
						locked={binding?.locked ?? false}
						onToggle={() =>
							upsert(item.id, { locked: !(binding?.locked ?? false) })
						}
					/>
				)}
			</div>
		);
	};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Each runs on the request/response path with a Block / Warn / Sanitize action. Offline-only evaluators (quality, conversation, trajectory, voice) are not shown here; they live on the agent Evals surface. A ‘not yet enforced’ evaluator is catalogued but not wired to execution yet."
					}
				>
					{"Typed evaluators that run inline as guardrails at this scope."}
				</CaptionInfo>
			}
			headerAction={
				<PipelineBadge
					active={pipelineStages?.includes("inline-input") ?? true}
				/>
			}
			title="Evaluators"
		>
			{/* This list shows only inline-capable evaluators and the Gateway never
			    runs code inline, so it offers the judge editor alone; a code
			    evaluator would be saved but never listed here. The agent Evals
			    surface creates code evaluators. */}
			<EvaluatorCatalog
				disabled={ctx.disabled}
				error={error}
				items={items}
				loading={loading}
				mode="inline"
				onCreateJudge={() => setEditorMode("judge")}
				onDeleteCustom={(id) => {
					handleDeleteCustom(id).catch(() => undefined);
				}}
				onSearchChange={setSearch}
				renderControl={renderControl}
				search={search}
			/>
			<EvaluatorEditorDialog
				existingCustom={customSet}
				existingIds={allIds}
				mode={editorMode ?? "judge"}
				onOpenChange={(o) => {
					if (!o) {
						setEditorMode(null);
					}
				}}
				onSaved={() => setReloadKey((k) => k + 1)}
				open={editorMode !== null}
				target={target}
			/>
		</SettingsSection>
	);
}
