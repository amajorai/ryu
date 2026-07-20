"use client";

// Presentational layer of the desktop Monitors view. The live Monitors UI was
// extracted into the sandboxed `com.ryu.monitors` companion app
// (`packages/monitors-app`), which owns selection/editing state + data fetching
// over the `window.ryu.monitors.*` bridge; the shell `MonitorsPage`/`useMonitors`
// were deleted in that cutover. This block's only remaining consumer is the
// internal storyboard (mock data, no-op handlers). One source of truth, so editing this block changes the
// real desktop too.
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
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
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
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useState } from "react";

// ── Monitor model (mirrors apps/desktop/src/lib/api/monitors.ts) ──────────────

export type FetchBackend = "http" | "spider" | "agentbrowser";

export type NumComparator =
	| "changed"
	| "less_than"
	| "greater_than"
	| "drops_by_pct"
	| "rises_by_pct";

export type CheckType =
	| { type: "uptime"; expect_status?: number[] }
	| {
			type: "keyword";
			pattern: string;
			is_regex?: boolean;
			case_sensitive?: boolean;
			alert_when_present?: boolean;
	  }
	| { type: "content_diff"; region_regex?: string | null }
	| {
			type: "price";
			extract_regex: string;
			comparator?: NumComparator;
			threshold?: number | null;
	  }
	| {
			type: "stock";
			in_stock_pattern: string;
			is_regex?: boolean;
			alert_when_in_stock?: boolean;
	  };

export type NotifyTarget =
	| { kind: "webhook"; url: string }
	| { kind: "telegram"; bot_token: string; chat_id: string }
	| { kind: "expo_push"; token: string };

export type CheckStatus = "ok" | "triggered" | "error";

export interface Monitor {
	backend: FetchBackend;
	check: CheckType;
	enabled: boolean;
	id: string;
	interval: string;
	last_status?: CheckStatus | null;
	last_value?: string | null;
	name: string;
	notify: NotifyTarget[];
	url: string;
}

export interface Snapshot {
	checked_at: string;
	http_status?: number | null;
	id: number;
	latency_ms?: number | null;
	note?: string | null;
	status: CheckStatus;
	value?: string | null;
}

export interface Alert {
	created_at: string;
	id: number;
	message: string;
	title: string;
}

export interface MonitorInput {
	backend: FetchBackend;
	check: CheckType;
	enabled: boolean;
	interval: string;
	name: string;
	notify: NotifyTarget[];
	url: string;
}

type CheckKind = CheckType["type"];

const CHECK_LABELS: Record<CheckKind, string> = {
	uptime: "Uptime",
	keyword: "Keyword",
	content_diff: "Content change",
	price: "Price",
	stock: "Stock / inventory",
};

function statusColor(status?: CheckStatus | null): string {
	if (status === "ok") {
		return "bg-emerald-500";
	}
	if (status === "triggered") {
		return "bg-amber-500";
	}
	if (status === "error") {
		return "bg-red-500";
	}
	return "bg-muted-foreground/40";
}

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
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
	name: string;
	notify: NotifyTarget[];
	pattern: string;
	regionRegex: string;
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
	isRegex: false,
	caseSensitive: false,
	alertWhenPresent: true,
	regionRegex: "",
	extractRegex: "\\$([0-9.,]+)",
	comparator: "changed",
	threshold: "",
	notify: [],
};

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
		default:
			return { type: "uptime" };
	}
}

function buildInput(f: FormState): MonitorInput {
	return {
		name: f.name.trim(),
		url: f.url.trim(),
		backend: f.backend,
		interval: f.interval.trim(),
		enabled: f.enabled,
		check: buildCheck(f),
		notify: f.notify,
	};
}

function patch<K extends keyof FormState>(
	set: React.Dispatch<React.SetStateAction<FormState>>,
	key: K
) {
	return (value: FormState[K]) => set((prev) => ({ ...prev, [key]: value }));
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CheckTypeFields({
	form,
	setForm,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
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
							patch(setForm, "comparator")(e.target.value as NumComparator)
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

function NotifyEditor({
	notify,
	setForm,
}: {
	notify: NotifyTarget[];
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	const update = (next: NotifyTarget[]) =>
		setForm((prev) => ({ ...prev, notify: next }));
	const addWebhook = () => update([...notify, { kind: "webhook", url: "" }]);
	const addTelegram = () =>
		update([...notify, { kind: "telegram", bot_token: "", chat_id: "" }]);
	const removeAt = (i: number) => update(notify.filter((_, idx) => idx !== i));
	const patchAt = (i: number, p: Partial<NotifyTarget>) =>
		update(
			notify.map((t, idx) => (idx === i ? ({ ...t, ...p } as NotifyTarget) : t))
		);

	return (
		<div className="space-y-2">
			<Label>Notify (in-app + mobile push are automatic)</Label>
			{notify.map((t, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: notify targets have no stable id and reorder by index
				<div className="flex items-center gap-2" key={`${t.kind}-${i}`}>
					{t.kind === "webhook" ? (
						<Input
							className="flex-1"
							onChange={(e) => patchAt(i, { url: e.target.value })}
							placeholder="Slack/Discord webhook URL"
							value={t.url}
						/>
					) : null}
					{t.kind === "telegram" ? (
						<>
							<Input
								className="flex-1"
								onChange={(e) => patchAt(i, { bot_token: e.target.value })}
								placeholder="Bot token"
								value={t.bot_token}
							/>
							<Input
								className="w-32"
								onChange={(e) => patchAt(i, { chat_id: e.target.value })}
								placeholder="Chat ID"
								value={t.chat_id}
							/>
						</>
					) : null}
					<Button
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
			</div>
		</div>
	);
}

function MonitorForm({
	initial,
	saving,
	onSave,
	onCancel,
}: {
	initial: FormState;
	saving: boolean;
	onSave: (input: MonitorInput) => void;
	onCancel: () => void;
}) {
	const [form, setForm] = useState<FormState>(initial);
	useEffect(() => setForm(initial), [initial]);

	const canSave = form.name.trim() !== "" && form.url.trim() !== "";

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
			<div className="space-y-1.5">
				<Label htmlFor="m-url">URL</Label>
				<Input
					id="m-url"
					onChange={(e) => patch(setForm, "url")(e.target.value)}
					placeholder="https://example.com/product"
					value={form.url}
				/>
			</div>
			<div className="flex gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="m-type">What to monitor</Label>
					<NativeSelect
						className="w-full"
						id="m-type"
						onChange={(e) =>
							patch(setForm, "checkType")(e.target.value as CheckKind)
						}
						value={form.checkType}
					>
						{(Object.keys(CHECK_LABELS) as CheckKind[]).map((k) => (
							<NativeSelectOption key={k} value={k}>
								{CHECK_LABELS[k]}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="w-40 space-y-1.5">
					<Label htmlFor="m-backend">Fetch via</Label>
					<NativeSelect
						className="w-full"
						id="m-backend"
						onChange={(e) =>
							patch(setForm, "backend")(e.target.value as FetchBackend)
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
				<div className="w-32 space-y-1.5">
					<Label htmlFor="m-interval">Every</Label>
					<Input
						id="m-interval"
						onChange={(e) => patch(setForm, "interval")(e.target.value)}
						placeholder="10m"
						value={form.interval}
					/>
				</div>
			</div>

			<CheckTypeFields form={form} setForm={setForm} />
			<NotifyEditor notify={form.notify} setForm={setForm} />

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
					onClick={() => onSave(buildInput(form))}
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
}: {
	monitor: Monitor;
	running: boolean;
	snapshots: Snapshot[];
	alerts: Alert[];
	onRun: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<div className="mx-auto max-w-2xl space-y-5">
			<div className="flex items-start justify-between">
				<div>
					<h1 className="font-semibold text-lg">{monitor.name}</h1>
					<a
						className="text-muted-foreground text-sm hover:underline"
						href={monitor.url}
						rel="noopener noreferrer"
						target="_blank"
					>
						{monitor.url}
					</a>
				</div>
				<div className="flex gap-2">
					<Button disabled={running} onClick={onRun} size="sm">
						<HugeiconsIcon className="size-4" icon={PlayIcon} />
						{running ? "Checking…" : "Run now"}
					</Button>
					<Button onClick={onEdit} size="sm" variant="outline">
						Edit
					</Button>
					<Button onClick={onDelete} size="sm" variant="ghost">
						<HugeiconsIcon
							className="size-4 text-destructive"
							icon={Delete02Icon}
						/>
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap gap-2 text-sm">
				<Badge variant="secondary">{CHECK_LABELS[monitor.check.type]}</Badge>
				<Badge variant="outline">every {monitor.interval}</Badge>
				<Badge variant="outline">{monitor.backend}</Badge>
				{monitor.last_status ? (
					<span className="inline-flex items-center gap-1.5">
						<span
							className={`inline-block size-2 rounded-full ${statusColor(monitor.last_status)}`}
						/>
						{monitor.last_value ?? monitor.last_status}
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
									{s.value ?? s.note ?? ""}
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
	/** id of the monitor currently being run, or null. */
	runningId?: string | null;
	saving?: boolean;
	/** Controlled selection; the container needs it to fetch snapshots/alerts. */
	selectedId?: string | null;
	/** Snapshots/alerts for the selected monitor (fetched by the container). */
	snapshots?: Snapshot[];
}

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
}: MonitorsViewProps) {
	const selected = monitors.find((m) => m.id === selectedId) ?? null;
	const initialForm =
		isNew || !selected ? EMPTY_MONITOR_FORM : formFromMonitor(selected);

	return (
		<div className="flex h-full overflow-hidden">
			<div className="flex w-64 shrink-0 flex-col border-r">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="font-semibold text-sm">Monitors</span>
					<Button onClick={onNew} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
					</Button>
				</div>
				{loading ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner />
					</div>
				) : (
					<ul className="flex-1 space-y-0.5 overflow-y-auto p-1">
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
									<span className="min-w-0 flex-1 truncate text-sm">
										{m.name}
									</span>
									{runningId === m.id ? <Spinner className="size-3" /> : null}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="flex-1 overflow-y-auto p-6">
				{error ? (
					<p className="mb-3 text-destructive text-sm">{error}</p>
				) : null}
				{editing ? (
					<MonitorForm
						initial={initialForm}
						onCancel={() => onCancelEdit?.()}
						onSave={(input) => onSave?.(input)}
						saving={saving}
					/>
				) : selected ? (
					<MonitorDetail
						alerts={alerts}
						monitor={selected}
						onDelete={() => onDelete?.(selected.id)}
						onEdit={() => onEdit?.()}
						onRun={() => onRun?.(selected.id)}
						running={runningId === selected.id}
						snapshots={snapshots}
					/>
				) : (
					<Empty>
						<EmptyHeader>
							<HugeiconsIcon
								className="size-8 text-muted-foreground"
								icon={RefreshIcon}
							/>
							<EmptyTitle>Watch a website</EmptyTitle>
							<EmptyDescription>
								Track price drops, stock, keywords, content changes, or uptime
								and get notified when something changes.
							</EmptyDescription>
						</EmptyHeader>
						<Button onClick={onNew}>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New monitor
						</Button>
					</Empty>
				)}
			</div>
		</div>
	);
}
