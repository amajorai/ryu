import type {
	CheckStatus,
	CheckType,
	FetchBackend,
	Monitor,
	MonitorInput,
	NotifyTarget,
	NumComparator,
	PublicNotifyTarget,
} from "@ryuhq/core-client/monitors";
import { z } from "zod";

type CheckKind = CheckType["type"];

// These are the complete authored native select values. Synthetic unsupported
// selections fail before they can create a MonitorInput with an invalid enum.
export const comparatorSelection = z.enum([
	"changed",
	"less_than",
	"greater_than",
	"drops_by_pct",
	"rises_by_pct",
]) satisfies z.ZodType<NumComparator>;
export const checkSelection = z.enum([
	"uptime",
	"keyword",
	"content_diff",
	"price",
	"stock",
	"provider_usage_reset",
]) satisfies z.ZodType<CheckKind>;
export const backendSelection = z.enum([
	"http",
	"spider",
	"agentbrowser",
]) satisfies z.ZodType<FetchBackend>;

export const CHECK_LABELS = {
	uptime: "Uptime",
	keyword: "Keyword",
	content_diff: "Content change",
	price: "Price",
	stock: "Stock / inventory",
	provider_usage_reset: "Provider usage reset",
} satisfies Record<CheckKind, string>;

export function statusColor(status?: CheckStatus | null): string {
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

export interface FormState {
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

export function safeMonitorUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

export function formFromMonitor(m: Monitor): FormState {
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

export function buildCheck(f: FormState): CheckType {
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

export function buildInput(f: FormState, notify: NotifyTarget[]): MonitorInput {
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

export function patch<K extends keyof FormState>(
	set: React.Dispatch<React.SetStateAction<FormState>>,
	key: K
) {
	return (value: FormState[K]) => set((prev) => ({ ...prev, [key]: value }));
}
