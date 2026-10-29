import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";

export type NotificationFilter =
	| "all"
	| "unread"
	| "archived"
	| `level:${string}`;

export interface NotificationFilterItem {
	archived_at?: string | null;
	level: string;
	read_at?: string | null;
}

export interface NotificationFilterOption {
	count: number;
	label: string;
	value: NotificationFilter;
}

const STATUS_LABELS = {
	all: "All",
	unread: "Unread",
	archived: "Archived",
} satisfies Record<"all" | "unread" | "archived", string>;

const PREFERRED_LEVEL_ORDER = ["info", "success", "warning", "error"];
const LEVEL_SEPARATOR = /[_\s-]+/;

export function normalizeNotificationLevel(level: string): string {
	const normalized = level.trim().toLowerCase();
	return normalized || "info";
}

export function notificationLevelLabel(level: string): string {
	return normalizeNotificationLevel(level)
		.split(LEVEL_SEPARATOR)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export function notificationFilterForLevel(level: string): NotificationFilter {
	return `level:${normalizeNotificationLevel(level)}`;
}

export function notificationFilterLabel(filter: NotificationFilter): string {
	if (filter === "all" || filter === "unread" || filter === "archived") {
		return STATUS_LABELS[filter];
	}
	return notificationLevelLabel(filter.slice("level:".length));
}

export function isArchivedNotification(item: NotificationFilterItem): boolean {
	return Boolean(item.archived_at);
}

export function isUnreadNotification(item: NotificationFilterItem): boolean {
	return !(item.read_at || isArchivedNotification(item));
}

export function filterNotifications<T extends NotificationFilterItem>(
	items: readonly T[],
	filter: NotificationFilter
): T[] {
	if (filter === "all") {
		return items.filter(() => true);
	}
	if (filter === "unread") {
		return items.filter(isUnreadNotification);
	}
	if (filter === "archived") {
		return items.filter(isArchivedNotification);
	}

	const level = filter.slice("level:".length);
	return items.filter(
		(item) => normalizeNotificationLevel(item.level) === level
	);
}

export function notificationFilterOptions<T extends NotificationFilterItem>(
	items: readonly T[]
): NotificationFilterOption[] {
	const levelCounts = new Map<string, number>();
	for (const item of items) {
		const level = normalizeNotificationLevel(item.level);
		levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
	}

	const levels = [...levelCounts.keys()].sort((left, right) => {
		const leftIndex = PREFERRED_LEVEL_ORDER.indexOf(left);
		const rightIndex = PREFERRED_LEVEL_ORDER.indexOf(right);
		if (leftIndex === -1 && rightIndex === -1) {
			return left.localeCompare(right);
		}
		if (leftIndex === -1) {
			return 1;
		}
		if (rightIndex === -1) {
			return -1;
		}
		return leftIndex - rightIndex;
	});

	return [
		{
			count: items.length,
			label: STATUS_LABELS.all,
			value: "all",
		},
		{
			count: items.filter(isUnreadNotification).length,
			label: STATUS_LABELS.unread,
			value: "unread",
		},
		{
			count: items.filter(isArchivedNotification).length,
			label: STATUS_LABELS.archived,
			value: "archived",
		},
		...levels.map((level) => ({
			count: levelCounts.get(level) ?? 0,
			label: notificationLevelLabel(level),
			value: notificationFilterForLevel(level),
		})),
	];
}

export function NotificationFilterTabs<T extends NotificationFilterItem>({
	ariaLabel = "Notification filters",
	className,
	items,
	onValueChange,
	showCounts = true,
	value,
}: {
	ariaLabel?: string;
	className?: string;
	items: readonly T[];
	onValueChange: (value: NotificationFilter) => void;
	showCounts?: boolean;
	value: NotificationFilter;
}) {
	const options = notificationFilterOptions(items);
	const currentOption = options.some((option) => option.value === value)
		? null
		: value.startsWith("level:")
			? {
					count: 0,
					label: notificationFilterLabel(value),
					value,
				}
			: null;
	const visibleOptions = currentOption ? [...options, currentOption] : options;

	return (
		<Tabs
			className={cn("min-w-0 max-w-full", className)}
			onValueChange={(nextValue) => {
				const selected = visibleOptions.find(
					(option) => option.value === nextValue
				);
				if (selected) {
					onValueChange(selected.value);
				}
			}}
			value={value}
		>
			<TabsList
				aria-label={ariaLabel}
				className="max-w-full"
				manageLayout={false}
				persistLayout={false}
				variant="pills"
			>
				{visibleOptions.map((option) => (
					<TabsTrigger
						className="shrink-0"
						key={option.value}
						value={option.value}
					>
						<span>{option.label}</span>
						{showCounts ? (
							<span className="type-compact tabular-nums opacity-60">
								{option.count}
							</span>
						) : null}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
