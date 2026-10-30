"use client";

// Presentational layer of the desktop Monitors view. The live Monitors UI is
// shared with the sandboxed `@ryu/monitors` Companion app, which owns selection,
// editing state, and data fetching over the `window.ryu.monitors.*` bridge.
//
// Selection and edit/new mode are controlled by the container (it needs the
// selection to fetch snapshots/alerts). The only local state here is the create/
// edit form's field values — plain UI state, not app/backend/Tauri state.

import { Add01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import type {
	Alert,
	Monitor,
	MonitorInput,
	ProviderUsageSnapshot,
	Snapshot,
	UsageProviderOption,
} from "@ryuhq/core-client/monitors";
import { useMemo } from "react";
import { MonitorDetail } from "./monitors-detail.tsx";
import { MonitorForm } from "./monitors-form.tsx";
import {
	EMPTY_MONITOR_FORM,
	formFromMonitor,
	statusColor,
} from "./monitors-form-state.ts";
import { UsagePacingPanel } from "./monitors-pacing-panel.tsx";
import type {
	UsageAccountsByProvider,
	UsageSelectionChange,
} from "./monitors-usage-accounts.ts";

export type {
	Alert,
	CheckStatus,
	CheckType,
	FetchBackend,
	Monitor,
	MonitorInput,
	NotifyTarget,
	NumComparator,
	ProviderUsageSnapshot,
	Snapshot,
	UsageProviderOption,
} from "./monitor-types.ts";
export { EMPTY_MONITOR_FORM } from "./monitors-form-state.ts";
export type {
	UsageAccountOption,
	UsageAccountsByProvider,
	UsageSelectionChange,
} from "./monitors-usage-accounts.ts";

// ── View ──────────────────────────────────────────────────────────────────────

export interface MonitorsViewProps {
	alerts?: Alert[];
	/** Controlled edit mode (form shown for create or edit). */
	editing?: boolean;
	error?: string | null;
	/** True when the edit form is for a brand-new monitor. */
	isNew?: boolean;
	loading?: boolean;
	monitors: Monitor[];
	onCancelEdit?: () => void;
	onDelete?: (id: string) => void;
	onEdit?: () => void;
	onNew?: () => void;
	onRun?: (id: string) => void;
	onSave?: (input: MonitorInput) => void;
	onSelect?: (id: string | null) => void;
	/** The editor's provider or watched account changed; absent `accountId`
	 *  means the active account. */
	onUsageProviderChange?: UsageSelectionChange;
	providerCatalogLoading?: boolean;
	/** id of the monitor currently being run, or null. */
	runningId?: string | null;
	saving?: boolean;
	/** Controlled selection; the container needs it to fetch snapshots/alerts. */
	selectedId?: string | null;
	/** Snapshots/alerts for the selected monitor (fetched by the container). */
	snapshots?: Snapshot[];
	/**
	 * Saved accounts per provider, only for providers that report per-account
	 * usage. A provider with no entry hides the account picker. Labels are
	 * rendered only; monitors store account ids.
	 */
	usageAccounts?: UsageAccountsByProvider;
	usageError?: string | null;
	usageLoading?: boolean;
	/** Provider whose normalized usage is shown in the pacing panel or editor. */
	usageProviderId?: string | null;
	/** Provider usage readers from Core, used by provider-reset monitors. */
	usageProviders?: UsageProviderOption[];
	/** Latest normalized snapshot for the provider selected in the editor. */
	usageSnapshot?: ProviderUsageSnapshot;
}

const NO_USAGE_ACCOUNTS: UsageAccountsByProvider = {};

export function MonitorsView({
	loading,
	error,
	monitors,
	selectedId = null,
	onSelect,
	editing = false,
	isNew = false,
	saving = false,
	runningId = null,
	snapshots = [],
	alerts = [],
	onNew,
	onEdit,
	onCancelEdit,
	onSave,
	onRun,
	onDelete,
	usageProviders = [],
	usageAccounts = NO_USAGE_ACCOUNTS,
	usageSnapshot,
	usageProviderId = null,
	usageLoading = false,
	providerCatalogLoading = false,
	usageError,
	onUsageProviderChange,
}: MonitorsViewProps) {
	useTimezoneRevision();
	const selected = monitors.find((m) => m.id === selectedId) ?? null;
	const initialForm = useMemo(
		() => (isNew || !selected ? EMPTY_MONITOR_FORM : formFromMonitor(selected)),
		[isNew, selected]
	);

	return (
		<div className="flex h-full overflow-hidden">
			<div className="flex w-64 shrink-0 flex-col border-r">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="font-medium text-sm">Monitors</span>
					<Button
						aria-label="New monitor"
						onClick={onNew}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
					</Button>
				</div>
				{loading ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner />
					</div>
				) : (
					<ul className="scroll-fade flex-1 space-y-0.5 overflow-y-auto p-1">
						{monitors.map((m) => (
							<li key={m.id}>
								<button
									className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent ${
										selectedId === m.id && !isNew ? "bg-accent" : ""
									}`}
									onClick={() => onSelect?.(m.id)}
									type="button"
								>
									<span
										className={`inline-block size-2 shrink-0 rounded-full ${statusColor(m.last_status)}`}
									/>
									<span
										className="min-w-0 flex-1 truncate text-sm"
										title={m.name}
									>
										{m.name}
									</span>
									{runningId === m.id ? <Spinner className="size-3" /> : null}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="scroll-fade flex-1 overflow-y-auto p-6">
				{error ? (
					<p className="mb-3 text-sm text-status-destructive">{error}</p>
				) : null}
				{editing ? (
					<MonitorForm
						initial={initialForm}
						onCancel={() => onCancelEdit?.()}
						onSave={(input) => onSave?.(input)}
						onUsageProviderChange={onUsageProviderChange ?? (() => {})}
						providerCatalogLoading={providerCatalogLoading}
						providerOptions={usageProviders}
						saving={saving}
						usageAccounts={usageAccounts}
						usageError={usageError}
						usageLoading={usageLoading}
						usageSnapshot={usageSnapshot}
					/>
				) : selected ? (
					<MonitorDetail
						alerts={alerts}
						monitor={selected}
						onDelete={() => onDelete?.(selected.id)}
						onEdit={() => onEdit?.()}
						onRun={() => onRun?.(selected.id)}
						providerOptions={usageProviders}
						running={runningId === selected.id}
						snapshots={snapshots}
						usageAccounts={usageAccounts}
					/>
				) : (
					<div className="mx-auto w-full max-w-3xl space-y-6">
						<UsagePacingPanel
							onProviderChange={onUsageProviderChange}
							providerCatalogLoading={providerCatalogLoading}
							providerId={usageProviderId}
							providerOptions={usageProviders}
							usageError={usageError}
							usageLoading={usageLoading}
							usageSnapshot={usageSnapshot}
						/>
						<Empty className="w-full">
							<EmptyHeader>
								<HugeiconsIcon
									className="size-8 text-muted-foreground"
									icon={RefreshIcon}
								/>
								<EmptyTitle>Watch a website or provider</EmptyTitle>
								<EmptyDescription>
									Track page changes or provider usage resets and choose where
									each alert is delivered.
								</EmptyDescription>
							</EmptyHeader>
							<Button onClick={onNew}>
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								New monitor
							</Button>
						</Empty>
					</div>
				)}
			</div>
		</div>
	);
}
