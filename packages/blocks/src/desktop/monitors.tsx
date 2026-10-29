"use client";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";

// Presentational layer of the desktop Monitors view. The live Monitors UI is
// shared with the sandboxed `@ryu/monitors` Companion app, which owns selection,
// editing state, and data fetching over the `window.ryu.monitors.*` bridge.
//
// Selection and edit/new mode are controlled by the container (it needs the
// selection to fetch snapshots/alerts). The only local state here is the create/
// edit form's field values — plain UI state, not app/backend/Tauri state.

import {
	Add01Icon,
	Delete02Icon,
	PlayIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Progress } from "@ryu/ui/components/progress";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { formatDateTime, useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type {
	Alert,
	CheckStatus,
	CheckType,
	FetchBackend,
	Monitor,
	MonitorInput,
	NotifyTarget,
	NumComparator,
	ProviderUsageSnapshot,
	PublicNotifyTarget,
	Snapshot,
	UsageProviderOption,
	UsageWindowTarget,
} from "@ryuhq/core-client/monitors";
import { monitorNotifyTargetsInputSchema } from "@ryuhq/core-client/monitors";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { estimateUsagePacing } from "./usage-pacing.ts";

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

type CheckKind = CheckType["type"];

/**
 * A saved provider account offered by the reset-monitor account picker. The
 * label may be an email address: render it, never persist it into a monitor.
 */
export interface UsageAccountOption {
	accountId: string;
	active: boolean;
	label: string | null;
	needsReauth?: boolean;
}

/** Saved accounts keyed by provider id, for providers with per-account usage. */
export type UsageAccountsByProvider = Readonly<
	Record<string, readonly UsageAccountOption[]>
>;

/** Called when the editor's provider or watched account changes. An absent
 *  `accountId` means the provider's active account. */
export type UsageSelectionChange = (
	providerId: string | null,
	accountId?: string
) => void;

/** Explain an unavailable reading. No reason means Core has not read this
 *  account yet and chose not to wait on the provider. */
function unavailableUsageMessage(reason: string | null | undefined): string {
	if (!reason) {
		return "Usage for this account has not been read yet. It updates within a minute.";
	}
	if (reason === "account_not_found") {
		return "This account is no longer saved for this provider.";
	}
	return `Usage is unavailable for this account (${reason}).`;
}

function accountOptionLabel(account: UsageAccountOption): string {
	const name = account.label ?? "Saved account";
	if (account.needsReauth) {
		return `${name} (sign in again)`;
	}
	return account.active ? `${name} (active)` : name;
}

/** Name the account a provider-reset monitor watches, resolved at render time
 *  so account labels are never stored in the monitor itself. */
function watchedAccountLabel(
	accountId: string | null | undefined,
	accounts: readonly UsageAccountOption[]
): string {
	if (!accountId) {
		return "active account";
	}
	const account = accounts.find((option) => option.accountId === accountId);
	if (!account) {
		return "removed account";
	}
	return account.label ?? "saved account";
}

// These are the complete authored native select values. Synthetic unsupported
// selections fail before they can create a MonitorInput with an invalid enum.
const comparatorSelection = z.enum([
	"changed",
	"less_than",
	"greater_than",
	"drops_by_pct",
	"rises_by_pct",
]) satisfies z.ZodType<NumComparator>;
const checkSelection = z.enum([
	"uptime",
	"keyword",
	"content_diff",
	"price",
	"stock",
	"provider_usage_reset",
]) satisfies z.ZodType<CheckKind>;
const backendSelection = z.enum([
	"http",
	"spider",
	"agentbrowser",
]) satisfies z.ZodType<FetchBackend>;

const CHECK_LABELS = {
	uptime: "Uptime",
	keyword: "Keyword",
	content_diff: "Content change",
	price: "Price",
	stock: "Stock / inventory",
	provider_usage_reset: "Provider usage reset",
} satisfies Record<CheckKind, string>;

function statusColor(status?: CheckStatus | null): string {
	if (status === "ok") {
		return "bg-success";
	}
	if (status === "triggered") {
		return "bg-warning";
	}
	if (status === "error") {
		return "bg-destructive";
	}
	return "bg-muted-foreground/40";
}

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
	/** Watched saved account; empty follows the provider's active account. */
	accountId: string;
	alertWhenPresent: boolean;
	backend: FetchBackend;
	caseSensitive: boolean;
	checkType: CheckKind;
	comparator: NumComparator;
	enabled: boolean;
	expectStatus: string;
	extractRegex: string;
	interval: string;
	isRegex: boolean;
	minimumDropPercent: string;
	name: string;
	notify: PublicNotifyTarget[];
	pattern: string;
	providerId: string;
	regionRegex: string;
	targetIds: string[];
	threshold: string;
	url: string;
}

export const EMPTY_MONITOR_FORM: FormState = {
	name: "",
	url: "",
	backend: "http",
	interval: "10m",
	enabled: true,
	checkType: "uptime",
	expectStatus: "",
	pattern: "",
	minimumDropPercent: "5",
	accountId: "",
	providerId: "",
	targetIds: [],
	isRegex: false,
	caseSensitive: false,
	alertWhenPresent: true,
	regionRegex: "",
	extractRegex: "\\$([0-9.,]+)",
	comparator: "changed",
	threshold: "",
	notify: [],
};

function safeMonitorUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

function usageWindowLabel(window: UsageWindowTarget): string {
	return window.model ? `${window.label} · ${window.model}` : window.label;
}

function paceMessage(window: UsageWindowTarget): string {
	const label = usageWindowLabel(window);
	const estimate = estimateUsagePacing(window);
	switch (estimate.kind) {
		case "before-reset":
			return `At this pace, you may reach the ${label} limit around ${formatDateTime(estimate.limitAt, { dateStyle: "medium", timeStyle: "short" })}, before it resets ${formatDateTime(estimate.resetsAt, { dateStyle: "medium", timeStyle: "short" })}.`;
		case "reset-first":
			return `At this pace, about ${Math.round(estimate.projectedUseAtReset)}% of the ${label} window should be used by its reset ${formatDateTime(estimate.resetsAt, { dateStyle: "medium", timeStyle: "short" })}.`;
		case "at-limit":
			return `The ${label} window is at its reported limit.`;
		case "no-usage":
			return `No usage has been recorded for the ${label} window yet.`;
		case "warming-up":
			return `This ${label} window just started; wait a few minutes for a useful pace estimate.`;
		case "unavailable":
			return `This provider does not report enough timing data to estimate a pace for the ${label} window.`;
		default:
			return "Usage pace is unavailable.";
	}
}

function PaceMessage({ window }: { window: UsageWindowTarget }) {
	const message = useLocalizedText(paceMessage(window), { literal: true });
	return (
		<p className="text-muted-foreground text-sm" role="status">
			{message}
		</p>
	);
}

function UsagePacingPanel({
	providerOptions,
	providerCatalogLoading,
	providerId,
	usageError,
	usageLoading,
	usageSnapshot,
	onProviderChange,
}: {
	providerOptions: UsageProviderOption[];
	providerCatalogLoading: boolean;
	providerId: string | null;
	usageError?: string | null;
	usageLoading: boolean;
	usageSnapshot?: ProviderUsageSnapshot;
	onProviderChange?: (providerId: string | null) => void;
}) {
	const title = useLocalizedText("Usage pace", { literal: true });
	const description = useLocalizedText(
		"Estimate when a provider quota may run out from the average usage since its current window began.",
		{ literal: true }
	);
	const providers = providerOptions.filter(
		(provider) => provider.kind === "subscription"
	);
	return (
		<Card className="mx-auto w-full max-w-3xl">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent spacing="relaxed">
				<div className="max-w-sm space-y-1.5">
					<Label htmlFor="m-pacing-provider">Provider</Label>
					<NativeSelect
						className="w-full"
						id="m-pacing-provider"
						onChange={(event) => onProviderChange?.(event.target.value || null)}
						value={providerId ?? ""}
					>
						<NativeSelectOption value="">Choose a provider</NativeSelectOption>
						{providers.map((provider) => (
							<NativeSelectOption
								key={provider.providerId}
								value={provider.providerId}
							>
								{provider.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{providerCatalogLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Loading supported providers…
					</div>
				) : null}
				{!providerCatalogLoading && providers.length === 0 && !usageError ? (
					<p className="text-muted-foreground text-sm" role="status">
						No subscription usage readers are available on this node.
					</p>
				) : null}
				{usageError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{usageError}
					</p>
				) : null}
				{usageLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Reading current provider usage…
					</div>
				) : null}
				{usageSnapshot?.available === false ? (
					<p className="text-sm text-status-warning" role="status">
						{unavailableUsageMessage(usageSnapshot.reason)}
					</p>
				) : null}
				{usageSnapshot?.available && usageSnapshot.windows.length > 0 ? (
					<ul className="space-y-3">
						{usageSnapshot.windows.map((window) => (
							<li
								className="space-y-2 rounded-md border p-3"
								key={window.targetId}
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="font-medium text-sm">
										{usageWindowLabel(window)}
									</span>
									<span className="font-mono text-muted-foreground text-sm tabular-nums">
										{Math.round(window.usedPercent)}% used
									</span>
								</div>
								<Progress
									aria-label={`${usageWindowLabel(window)} usage`}
									value={Math.min(100, Math.max(0, window.usedPercent))}
								/>
								<PaceMessage window={window} />
							</li>
						))}
					</ul>
				) : null}
				{usageSnapshot?.available && usageSnapshot.windows.length === 0 ? (
					<p className="text-muted-foreground text-sm" role="status">
						This provider does not currently report timed usage windows.
					</p>
				) : null}
				{providerId || usageLoading || providerCatalogLoading ? null : (
					<p className="text-muted-foreground text-sm">
						Choose a provider to see its current usage pace.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

function formFromMonitor(m: Monitor): FormState {
	const base: FormState = { ...EMPTY_MONITOR_FORM, notify: [] };
	base.name = m.name;
	base.url = m.url;
	base.backend = m.backend;
	base.interval = m.interval;
	base.enabled = m.enabled;
	base.checkType = m.check.type;
	base.notify = m.notify ?? [];
	const c = m.check;
	if (c.type === "uptime") {
		base.expectStatus = (c.expect_status ?? []).join(", ");
	} else if (c.type === "keyword") {
		base.pattern = c.pattern;
		base.isRegex = c.is_regex ?? false;
		base.caseSensitive = c.case_sensitive ?? false;
		base.alertWhenPresent = c.alert_when_present ?? true;
	} else if (c.type === "content_diff") {
		base.regionRegex = c.region_regex ?? "";
	} else if (c.type === "price") {
		base.extractRegex = c.extract_regex;
		base.comparator = c.comparator ?? "changed";
		base.threshold = c.threshold == null ? "" : String(c.threshold);
	} else if (c.type === "stock") {
		base.pattern = c.in_stock_pattern;
		base.isRegex = c.is_regex ?? false;
		base.alertWhenPresent = c.alert_when_in_stock ?? true;
	} else if (c.type === "provider_usage_reset") {
		base.providerId = c.provider_id;
		base.accountId = c.account_id ?? "";
		base.targetIds = c.target_ids;
		base.minimumDropPercent = String(c.minimum_drop_percent);
	}
	return base;
}

function buildCheck(f: FormState): CheckType {
	switch (f.checkType) {
		case "uptime":
			return {
				type: "uptime",
				expect_status: f.expectStatus
					.split(",")
					.map((s) => Number.parseInt(s.trim(), 10))
					.filter((n) => Number.isFinite(n)),
			};
		case "keyword":
			return {
				type: "keyword",
				pattern: f.pattern,
				is_regex: f.isRegex,
				case_sensitive: f.caseSensitive,
				alert_when_present: f.alertWhenPresent,
			};
		case "content_diff":
			return {
				type: "content_diff",
				region_regex: f.regionRegex.trim() ? f.regionRegex : null,
			};
		case "price":
			return {
				type: "price",
				extract_regex: f.extractRegex,
				comparator: f.comparator,
				threshold: f.threshold.trim() ? Number(f.threshold) : null,
			};
		case "stock":
			return {
				type: "stock",
				in_stock_pattern: f.pattern,
				is_regex: f.isRegex,
				alert_when_in_stock: f.alertWhenPresent,
			};
		case "provider_usage_reset":
			return {
				type: "provider_usage_reset",
				provider_id: f.providerId,
				// Follow-active monitors omit the field and keep their legacy shape.
				...(f.accountId ? { account_id: f.accountId } : {}),
				target_ids: f.targetIds,
				minimum_drop_percent: Number(f.minimumDropPercent),
			};
		default:
			return { type: "uptime" };
	}
}

function buildInput(f: FormState, notify: NotifyTarget[]): MonitorInput {
	return {
		name: f.name.trim(),
		url:
			f.checkType === "provider_usage_reset"
				? `ryu-usage://${f.providerId}`
				: f.url.trim(),
		backend: f.backend,
		interval: f.interval.trim(),
		enabled: f.enabled,
		check: buildCheck(f),
		notify,
	};
}

function patch<K extends keyof FormState>(
	set: React.Dispatch<React.SetStateAction<FormState>>,
	key: K
) {
	return (value: FormState[K]) => set((prev) => ({ ...prev, [key]: value }));
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UsageAccountSelect({
	accountId,
	accounts,
	onChange,
}: {
	accountId: string;
	accounts: readonly UsageAccountOption[];
	onChange: (accountId: string) => void;
}) {
	const pinnedMissing =
		accountId !== "" &&
		!accounts.some((account) => account.accountId === accountId);
	return (
		<div className="space-y-1.5">
			<Label htmlFor="m-usage-account">Account</Label>
			<NativeSelect
				className="w-full"
				id="m-usage-account"
				onChange={(event) => onChange(event.target.value)}
				value={accountId}
			>
				<NativeSelectOption value="">Follow active account</NativeSelectOption>
				{accounts.map((account) => (
					<NativeSelectOption key={account.accountId} value={account.accountId}>
						{accountOptionLabel(account)}
					</NativeSelectOption>
				))}
				{pinnedMissing ? (
					<NativeSelectOption disabled value={accountId}>
						Removed account
					</NativeSelectOption>
				) : null}
			</NativeSelect>
			<p className="text-muted-foreground text-sm">
				{pinnedMissing
					? "This account is no longer saved. Choose another account to keep watching."
					: "Following the active account records a fresh baseline after you switch accounts, without alerting."}
			</p>
		</div>
	);
}

function CheckTypeFields({
	form,
	setForm,
	providerOptions = [],
	accountOptions = [],
	usageSnapshot,
	usageLoading = false,
	providerCatalogLoading = false,
	usageError,
	onUsageProviderChange,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
	providerOptions?: UsageProviderOption[];
	/** Saved accounts of the selected provider; empty hides the account picker. */
	accountOptions?: readonly UsageAccountOption[];
	usageSnapshot?: ProviderUsageSnapshot;
	usageLoading?: boolean;
	providerCatalogLoading?: boolean;
	usageError?: string | null;
	onUsageProviderChange?: UsageSelectionChange;
}) {
	if (form.checkType === "provider_usage_reset") {
		const usageTargets = [
			...(usageSnapshot?.windows ?? []).map((window) => ({
				detail: `${window.usedPercent.toFixed(1)}% used${window.resetsAt ? ` · resets ${window.resetsAt}` : ""}`,
				label: `${window.label}${window.model ? ` · ${window.model}` : ""}`,
				targetId: window.targetId,
			})),
			...(usageSnapshot?.meters ?? []).flatMap((meter) =>
				meter.values.map((value) => ({
					detail: `${value.number.toFixed(2)} ${value.unit ?? value.kind}${value.resetsAt ? ` · resets ${value.resetsAt}` : meter.resetsAt ? ` · resets ${meter.resetsAt}` : ""}`,
					label: meter.label,
					targetId: value.targetId,
				}))
			),
		];
		return (
			<div className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="m-usage-provider">Provider</Label>
					<NativeSelect
						className="w-full"
						id="m-usage-provider"
						onChange={(event) => {
							const providerId = event.target.value;
							setForm((previous) => ({
								...previous,
								accountId: "",
								providerId,
								targetIds: [],
							}));
							onUsageProviderChange?.(providerId || null);
						}}
						value={form.providerId}
					>
						<NativeSelectOption value="">Choose a provider</NativeSelectOption>
						{providerOptions.map((provider) => (
							<NativeSelectOption
								key={provider.providerId}
								value={provider.providerId}
							>
								{provider.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{form.providerId && accountOptions.length > 0 ? (
					<UsageAccountSelect
						accountId={form.accountId}
						accounts={accountOptions}
						onChange={(accountId) => {
							patch(setForm, "accountId")(accountId);
							onUsageProviderChange?.(form.providerId, accountId || undefined);
						}}
					/>
				) : null}
				{providerCatalogLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Loading supported providers…
					</div>
				) : null}
				{!providerCatalogLoading &&
				providerOptions.length === 0 &&
				!usageError ? (
					<p className="text-muted-foreground text-sm" role="status">
						No supported provider usage readers are available on this node.
					</p>
				) : null}
				{usageError ? (
					<p className="text-sm text-status-destructive" role="alert">
						{usageError}
					</p>
				) : null}
				{usageLoading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-4" /> Reading current provider usage…
					</div>
				) : null}
				{usageSnapshot?.available === false ? (
					<p className="text-sm text-status-warning" role="status">
						{unavailableUsageMessage(usageSnapshot.reason)}
					</p>
				) : null}
				{usageSnapshot?.available && usageTargets.length > 0 ? (
					<fieldset className="space-y-2">
						<legend className="font-medium text-sm">
							Windows and balances to watch
						</legend>
						{usageTargets.map((target) => (
							<label
								className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
								key={target.targetId}
							>
								<Checkbox
									checked={form.targetIds.includes(target.targetId)}
									onCheckedChange={(checked) =>
										setForm((previous) => ({
											...previous,
											targetIds: checked
												? previous.targetIds.includes(target.targetId)
													? previous.targetIds
													: [...previous.targetIds, target.targetId]
												: previous.targetIds.filter(
														(id) => id !== target.targetId
													),
										}))
									}
								/>
								<span className="min-w-0">
									<span className="block font-medium">{target.label}</span>
									<span className="block text-muted-foreground">
										{target.detail}
									</span>
								</span>
							</label>
						))}
					</fieldset>
				) : null}
				{usageSnapshot?.available && usageTargets.length === 0 ? (
					<p className="text-muted-foreground text-sm" role="status">
						This provider currently reports no usage windows or balances to
						watch.
					</p>
				) : null}
				{!(form.providerId || usageLoading || providerCatalogLoading) &&
				providerOptions.length > 0 ? (
					<p className="text-muted-foreground text-sm">
						Choose a provider to load its live windows and balances.
					</p>
				) : null}
				<div className="max-w-xs space-y-1.5">
					<Label htmlFor="m-reset-drop">Minimum usage drop to notify</Label>
					<div className="flex items-center gap-2">
						<Input
							id="m-reset-drop"
							max="100"
							min="0.1"
							onChange={(event) =>
								patch(setForm, "minimumDropPercent")(event.target.value)
							}
							step="0.1"
							type="number"
							value={form.minimumDropPercent}
						/>
						<span className="text-muted-foreground text-sm">
							percentage points
						</span>
					</div>
				</div>
				<p className="text-muted-foreground text-sm">
					The first check saves a baseline quietly. A window alerts when usage
					drops to near zero, falls by this many percentage points, or crosses a
					reported reset boundary. Credit balances alert when they increase.
				</p>
			</div>
		);
	}

	if (form.checkType === "uptime") {
		return (
			<div className="space-y-1.5">
				<Label htmlFor="m-status">Expected status codes (optional)</Label>
				<Input
					id="m-status"
					onChange={(e) => patch(setForm, "expectStatus")(e.target.value)}
					placeholder="200, 301 (blank = any 2xx/3xx is up)"
					value={form.expectStatus}
				/>
			</div>
		);
	}
	if (form.checkType === "keyword" || form.checkType === "stock") {
		const isStock = form.checkType === "stock";
		return (
			<div className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="m-pattern">
						{isStock ? "In-stock phrase" : "Keyword / pattern"}
					</Label>
					<Input
						id="m-pattern"
						onChange={(e) => patch(setForm, "pattern")(e.target.value)}
						placeholder={isStock ? "Add to cart" : "on sale"}
						value={form.pattern}
					/>
				</div>
				<label className="flex items-center gap-2 text-sm">
					<Switch
						checked={form.isRegex}
						onCheckedChange={(v) => patch(setForm, "isRegex")(Boolean(v))}
					/>
					Treat as regular expression
				</label>
				{isStock ? null : (
					<label className="flex items-center gap-2 text-sm">
						<Switch
							checked={form.caseSensitive}
							onCheckedChange={(v) =>
								patch(setForm, "caseSensitive")(Boolean(v))
							}
						/>
						Case sensitive
					</label>
				)}
				<label className="flex items-center gap-2 text-sm">
					<Switch
						checked={form.alertWhenPresent}
						onCheckedChange={(v) =>
							patch(setForm, "alertWhenPresent")(Boolean(v))
						}
					/>
					{isStock
						? "Alert when it comes in stock (off = when out of stock)"
						: "Alert when it appears (off = when it disappears)"}
				</label>
			</div>
		);
	}
	if (form.checkType === "content_diff") {
		return (
			<div className="space-y-1.5">
				<Label htmlFor="m-region">Region regex (optional)</Label>
				<Input
					id="m-region"
					onChange={(e) => patch(setForm, "regionRegex")(e.target.value)}
					placeholder="Capture group 1 scopes the watched region"
					value={form.regionRegex}
				/>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				<Label htmlFor="m-extract">Value regex (capture group 1)</Label>
				<Input
					id="m-extract"
					onChange={(e) => patch(setForm, "extractRegex")(e.target.value)}
					placeholder="\$([0-9.,]+)"
					value={form.extractRegex}
				/>
			</div>
			<div className="flex gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="m-cmp">Alert when</Label>
					<NativeSelect
						className="w-full"
						id="m-cmp"
						onChange={(e) =>
							patch(
								setForm,
								"comparator"
							)(comparatorSelection.parse(e.target.value))
						}
						value={form.comparator}
					>
						<NativeSelectOption value="changed">
							Value changes
						</NativeSelectOption>
						<NativeSelectOption value="less_than">
							Below threshold
						</NativeSelectOption>
						<NativeSelectOption value="greater_than">
							Above threshold
						</NativeSelectOption>
						<NativeSelectOption value="drops_by_pct">
							Drops by %
						</NativeSelectOption>
						<NativeSelectOption value="rises_by_pct">
							Rises by %
						</NativeSelectOption>
					</NativeSelect>
				</div>
				{form.comparator === "changed" ? null : (
					<div className="w-32 space-y-1.5">
						<Label htmlFor="m-threshold">Threshold</Label>
						<Input
							id="m-threshold"
							inputMode="decimal"
							onChange={(e) => patch(setForm, "threshold")(e.target.value)}
							value={form.threshold}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

interface NotifyFieldsPatch {
	bot_token?: Extract<NotifyTarget, { kind: "telegram" }>["bot_token"];
	chat_id?: Extract<NotifyTarget, { kind: "telegram" }>["chat_id"];
	to?: Extract<NotifyTarget, { kind: "email" }>["to"];
	url?: Extract<NotifyTarget, { kind: "webhook" }>["url"];
}

function NotifyEditor({
	notify,
	setForm,
}: {
	notify: PublicNotifyTarget[];
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	const update = (next: PublicNotifyTarget[]) =>
		setForm((prev) => ({ ...prev, notify: next }));
	const addWebhook = () => update([...notify, { kind: "webhook", url: "" }]);
	const addTelegram = () =>
		update([...notify, { kind: "telegram", bot_token: "", chat_id: "" }]);
	const addEmail = () => update([...notify, { kind: "email", to: "" }]);
	const removeAt = (i: number) => update(notify.filter((_, idx) => idx !== i));
	const patchAt = (i: number, p: NotifyFieldsPatch) =>
		update(notify.map((t, idx) => (idx === i ? { ...t, ...p } : t)));

	return (
		<div className="space-y-2">
			<Label>Notify (in-app + mobile push are automatic)</Label>
			{notify.map((t, i) => (
				<div className="flex items-center gap-2" key={`${t.kind}-${i}`}>
					{t.kind === "webhook" ? (
						<Input
							aria-label="Webhook URL"
							className="flex-1"
							onChange={(e) => patchAt(i, { url: e.target.value })}
							placeholder="Slack/Discord webhook URL"
							value={t.url}
						/>
					) : null}
					{t.kind === "telegram" ? (
						<>
							<Input
								aria-invalid={t.bot_token === undefined}
								aria-label="Telegram bot token"
								className="flex-1"
								onChange={(e) => patchAt(i, { bot_token: e.target.value })}
								placeholder={
									t.bot_token === undefined
										? "Enter bot token to save"
										: "Bot token"
								}
								value={t.bot_token}
							/>
							<Input
								aria-label="Telegram chat ID"
								className="w-32"
								onChange={(e) => patchAt(i, { chat_id: e.target.value })}
								placeholder="Chat ID"
								value={t.chat_id}
							/>
						</>
					) : null}
					{t.kind === "email" ? (
						<Input
							aria-label="Email recipient"
							className="flex-1"
							onChange={(e) => patchAt(i, { to: e.target.value })}
							placeholder="Email recipient"
							value={t.to}
						/>
					) : null}
					<Button
						aria-label="Remove notification target"
						onClick={() => removeAt(i)}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Delete02Icon} />
					</Button>
				</div>
			))}
			<div className="flex gap-2">
				<Button onClick={addWebhook} size="sm" type="button" variant="outline">
					+ Webhook
				</Button>
				<Button onClick={addTelegram} size="sm" type="button" variant="outline">
					+ Telegram
				</Button>
				<Button onClick={addEmail} size="sm" type="button" variant="outline">
					+ Email
				</Button>
			</div>
		</div>
	);
}

function MonitorForm({
	initial,
	saving,
	onSave,
	onCancel,
	providerOptions,
	usageAccounts,
	usageSnapshot,
	usageLoading,
	providerCatalogLoading,
	usageError,
	onUsageProviderChange,
}: {
	initial: FormState;
	saving: boolean;
	onSave: (input: MonitorInput) => void;
	onCancel: () => void;
	providerOptions: UsageProviderOption[];
	usageAccounts: UsageAccountsByProvider;
	usageSnapshot?: ProviderUsageSnapshot;
	usageLoading: boolean;
	providerCatalogLoading: boolean;
	usageError?: string | null;
	onUsageProviderChange: UsageSelectionChange;
}) {
	const [form, setForm] = useState<FormState>(initial);
	useEffect(() => setForm(initial), [initial]);
	useEffect(() => {
		if (form.checkType === "provider_usage_reset") {
			onUsageProviderChange(
				form.providerId || null,
				form.accountId || undefined
			);
		}
	}, [form.checkType, form.providerId, form.accountId, onUsageProviderChange]);
	const accountOptions = usageAccounts[form.providerId] ?? [];
	// A pin is kept when this host cannot list accounts; it must name a saved
	// account only when the list is known.
	const validAccount =
		form.accountId === "" ||
		accountOptions.length === 0 ||
		accountOptions.some((account) => account.accountId === form.accountId);

	const validMinimumDrop =
		Number.isFinite(Number(form.minimumDropPercent)) &&
		Number(form.minimumDropPercent) > 0 &&
		Number(form.minimumDropPercent) <= 100;
	const notifyInput = monitorNotifyTargetsInputSchema.safeParse(form.notify);
	const canSave =
		notifyInput.success &&
		form.name.trim() !== "" &&
		(form.checkType === "provider_usage_reset"
			? form.providerId !== "" &&
				form.targetIds.length > 0 &&
				validMinimumDrop &&
				validAccount
			: form.url.trim() !== "");
	const isProviderUsage = form.checkType === "provider_usage_reset";

	return (
		<div className="mx-auto max-w-2xl space-y-4">
			<div className="space-y-1.5">
				<Label htmlFor="m-name">Name</Label>
				<Input
					id="m-name"
					onChange={(e) => patch(setForm, "name")(e.target.value)}
					value={form.name}
				/>
			</div>
			{isProviderUsage ? null : (
				<div className="space-y-1.5">
					<Label htmlFor="m-url">URL</Label>
					<Input
						id="m-url"
						onChange={(e) => patch(setForm, "url")(e.target.value)}
						placeholder="https://example.com/product"
						value={form.url}
					/>
				</div>
			)}
			<div className="flex gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="m-type">What to monitor</Label>
					<NativeSelect
						className="w-full"
						id="m-type"
						onChange={(e) => {
							const checkType = checkSelection.parse(e.target.value);
							setForm((previous) => ({
								...previous,
								checkType,
								interval:
									checkType === "provider_usage_reset" &&
									previous.interval === "10m"
										? "5m"
										: previous.interval,
							}));
						}}
						value={form.checkType}
					>
						{Object.entries(CHECK_LABELS).map(([k, label]) => (
							<NativeSelectOption key={k} value={k}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{isProviderUsage ? null : (
					<div className="w-40 space-y-1.5">
						<Label htmlFor="m-backend">Fetch via</Label>
						<NativeSelect
							className="w-full"
							id="m-backend"
							onChange={(e) =>
								patch(
									setForm,
									"backend"
								)(backendSelection.parse(e.target.value))
							}
							value={form.backend}
						>
							<NativeSelectOption value="http">HTTP (fast)</NativeSelectOption>
							<NativeSelectOption value="spider">
								Spider crawler
							</NativeSelectOption>
							<NativeSelectOption value="agentbrowser">
								AI browser
							</NativeSelectOption>
						</NativeSelect>
					</div>
				)}
				<div className="w-32 space-y-1.5">
					<Label htmlFor="m-interval">Check every</Label>
					<Input
						id="m-interval"
						onChange={(e) => patch(setForm, "interval")(e.target.value)}
						placeholder="10m"
						value={form.interval}
					/>
				</div>
			</div>

			<CheckTypeFields
				accountOptions={accountOptions}
				form={form}
				onUsageProviderChange={onUsageProviderChange}
				providerCatalogLoading={providerCatalogLoading}
				providerOptions={providerOptions}
				setForm={setForm}
				usageError={usageError}
				usageLoading={usageLoading}
				usageSnapshot={usageSnapshot}
			/>
			<NotifyEditor notify={form.notify} setForm={setForm} />
			{notifyInput.success ? null : (
				<p className="text-muted-foreground text-sm" role="status">
					Enter the Telegram bot token before saving this monitor.
				</p>
			)}

			<label className="flex items-center gap-2 text-sm">
				<Switch
					checked={form.enabled}
					onCheckedChange={(v) => patch(setForm, "enabled")(Boolean(v))}
				/>
				Enabled
			</label>

			<div className="flex gap-2 pt-2">
				<Button
					disabled={!canSave || saving}
					onClick={() => {
						if (notifyInput.success) {
							onSave(buildInput(form, notifyInput.data));
						}
					}}
				>
					{saving ? "Saving…" : "Save monitor"}
				</Button>
				<Button onClick={onCancel} type="button" variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}

function MonitorDetail({
	monitor,
	running,
	snapshots,
	alerts,
	onRun,
	onEdit,
	onDelete,
	providerOptions,
	usageAccounts,
}: {
	monitor: Monitor;
	running: boolean;
	snapshots: Snapshot[];
	alerts: Alert[];
	onRun: () => void;
	onEdit: () => void;
	onDelete: () => void;
	providerOptions: UsageProviderOption[];
	usageAccounts: UsageAccountsByProvider;
}) {
	const monitorUrl = safeMonitorUrl(monitor.url);
	const check = monitor.check;
	const sourceLabel =
		check.type === "provider_usage_reset"
			? providerSourceLabel(
					check.provider_id,
					check.account_id,
					providerOptions,
					usageAccounts
				)
			: monitor.url;
	return (
		<div className="mx-auto max-w-2xl space-y-5">
			<div className="flex items-start justify-between">
				<div>
					<h1 className="font-medium text-lg">{monitor.name}</h1>
					{monitor.check.type === "provider_usage_reset" ? (
						<span className="text-muted-foreground text-sm">{sourceLabel}</span>
					) : monitorUrl ? (
						<a
							className="text-muted-foreground text-sm hover:underline"
							href={monitorUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							{monitor.url}
						</a>
					) : (
						<span className="text-muted-foreground text-sm">{monitor.url}</span>
					)}
				</div>
				<div className="flex gap-2">
					<Button disabled={running} onClick={onRun} size="sm">
						<HugeiconsIcon className="size-4" icon={PlayIcon} />
						{running ? "Checking…" : "Run now"}
					</Button>
					<Button onClick={onEdit} size="sm" variant="outline">
						Edit
					</Button>
					<Button
						aria-label="Delete monitor"
						onClick={onDelete}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className="size-4 text-status-destructive"
							icon={Delete02Icon}
						/>
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap gap-2 text-sm">
				<Badge variant="secondary">{CHECK_LABELS[monitor.check.type]}</Badge>
				<Badge variant="outline">every {monitor.interval}</Badge>
				<Badge variant="outline">
					{monitor.check.type === "provider_usage_reset"
						? "Core usage reader"
						: monitor.backend}
				</Badge>
				{monitor.last_status ? (
					<span className="inline-flex items-center gap-1.5">
						<span
							className={`inline-block size-2 rounded-full ${statusColor(monitor.last_status)}`}
						/>
						{formatMonitorValue(monitor, monitor.last_value) ??
							monitor.last_status}
					</span>
				) : null}
			</div>

			<section>
				<h2 className="mb-2 font-medium text-sm">Recent alerts</h2>
				{alerts.length > 0 ? (
					<ul className="space-y-1.5">
						{alerts.map((a) => (
							<li className="rounded-md border px-3 py-2 text-sm" key={a.id}>
								<div className="font-medium">{a.title}</div>
								<div className="text-muted-foreground">{a.message}</div>
								<div className="text-muted-foreground text-xs">
									{a.created_at}
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">No alerts yet.</p>
				)}
			</section>

			<section>
				<h2 className="mb-2 font-medium text-sm">Check history</h2>
				{snapshots.length > 0 ? (
					<ul className="space-y-1">
						{snapshots.map((s) => (
							<li
								className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
								key={s.id}
							>
								<span
									className={`inline-block size-2 rounded-full ${statusColor(s.status)}`}
								/>
								<span className="text-muted-foreground text-xs">
									{s.checked_at}
								</span>
								<span className="flex-1 truncate">
									{formatMonitorValue(monitor, s.value) ?? s.note ?? ""}
								</span>
								{s.http_status == null ? null : (
									<span className="text-muted-foreground text-xs">
										{s.http_status}
									</span>
								)}
								{s.latency_ms == null ? null : (
									<span className="text-muted-foreground text-xs">
										{s.latency_ms}ms
									</span>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">
						No checks recorded yet — hit “Run now”.
					</p>
				)}
			</section>
		</div>
	);
}

function providerSourceLabel(
	providerId: string,
	accountId: string | null | undefined,
	providerOptions: UsageProviderOption[],
	usageAccounts: UsageAccountsByProvider
): string {
	const provider =
		providerOptions.find((option) => option.providerId === providerId)?.label ??
		providerId;
	const accounts = usageAccounts[providerId] ?? [];
	// Without an account list (older host, or no per-account usage), only a
	// pinned monitor needs its account named.
	if (accounts.length === 0 && !accountId) {
		return `Provider usage · ${provider}`;
	}
	return `Provider usage · ${provider} · ${watchedAccountLabel(accountId, accounts)}`;
}

// Stored values can retain a previous check's JSON after a failed provider
// read. Observe raw native JSON cells rather than promise the current baseline.
interface ProviderStoredValueObservation {
	targets?: AppResponseValue;
}
interface ProviderStoredTargetObservation {
	kind?: AppResponseValue;
	label?: AppResponseValue;
	model?: AppResponseValue;
	number?: AppResponseValue;
	unit?: AppResponseValue;
	usedPercent?: AppResponseValue;
}

function formatMonitorValue(monitor: Monitor, raw: string | null | undefined) {
	if (!raw || monitor.check.type !== "provider_usage_reset") {
		return raw;
	}
	try {
		// SAFETY: This is only a lazy property-read view of the entire validated
		// native JSON node; it asserts no object brand, target presence or DTO.
		// Keep nil in the receiver domain so the original first read still fails.
		const snapshot = appResponseValueSchema.parse(JSON.parse(raw)) as
			| ProviderStoredValueObservation
			| null
			| undefined;
		// SAFETY: Native Object.values enumerates JSON descendants, string index
		// characters, or an empty scalar object; it establishes no target DTO.
		// The first snapshot read intentionally keeps the original nil failure.
		const targets = Object.values(
			snapshot!.targets ?? {}
		) as AppResponseValue[];
		const entries = targets.map((target) => {
			// SAFETY: Observe only the original raw JSON member cells, including
			// boxed scalar access and nil failure. No string/number/row guarantee.
			const reading = target as
				| ProviderStoredTargetObservation
				| null
				| undefined;
			const label = reading!.model
				? `${reading!.label ?? "Usage"} · ${reading!.model}`
				: (reading!.label ?? "Usage");
			if (reading!.kind === "window" && isNativeNumber(reading!.usedPercent)) {
				return `${label}: ${reading!.usedPercent.toFixed(1)}% used`;
			}
			if (reading!.kind === "meter" && isNativeNumber(reading!.number)) {
				return `${label}: ${reading!.number.toFixed(2)} ${reading!.unit ?? ""}`.trim();
			}
			return label;
		});
		return entries.length > 0 ? entries.join(" · ") : "Usage baseline recorded";
	} catch {
		return "Provider usage checked";
	}
}

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
