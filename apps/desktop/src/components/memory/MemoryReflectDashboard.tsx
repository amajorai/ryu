import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	enableUsageReview,
	getReflectDashboard,
	getReflectSettings,
	isUsageReviewDisabled,
	REFLECT_PERIODS,
	type ReflectDashboard,
	type ReflectPeriod,
	type ReflectSettings,
	updateReflectSettings,
} from "@/src/lib/api/memory.ts";

const PERIOD_LABELS = {
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
} satisfies Record<ReflectPeriod, string>;

function isUnsupported<TError>(error: TError): boolean {
	return error instanceof ApiError && [404, 405, 501].includes(error.status);
}

function formatTrend(trend: number | null): string | null {
	if (trend === null || trend === 0) {
		return null;
	}
	return `${trend > 0 ? "+" : ""}${trend}%`;
}

function formatHour(hour: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
	}).format(new Date(2020, 0, 1, hour));
}

// Mirrors Core's defaults so the switches don't flash a different state while
// the node's saved settings load.
const EMPTY_SETTINGS: ReflectSettings = {
	breakNudges: false,
	quietHoursEnabled: true,
	quietHoursEnd: 8,
	quietHoursStart: 22,
};

/** One stat: a muted label over a large tabular value, with the trend as quiet
 *  text. No card; the row of stats is separated by whitespace alone. */
function Stat({
	activity,
}: {
	activity: ReflectDashboard["activity"][number];
}) {
	const trend = formatTrend(activity.trend);
	return (
		<div className="flex flex-col gap-1">
			<p className="text-detail text-muted-foreground">{activity.label}</p>
			<p className="font-medium text-xl tabular-nums">
				{formatNumber(activity.count)}
			</p>
			{trend ? (
				<p className="text-muted-foreground/70 text-xs tabular-nums">{trend}</p>
			) : null}
		</div>
	);
}

/** A section title in the settings-section role, over hairline rows. */
function SectionTitle({ children }: { children: string }) {
	return <h3 className="mt-8 mb-1 font-semibold text-sm">{children}</h3>;
}

export function MemoryReflectDashboard({ target }: { target: ApiTarget }) {
	const [period, setPeriod] = useState<ReflectPeriod>("7d");
	const [dashboard, setDashboard] = useState<ReflectDashboard | null>(null);
	const [settings, setSettings] = useState<ReflectSettings>(EMPTY_SETTINGS);
	const [loading, setLoading] = useState(true);
	const [settingsLoading, setSettingsLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [enablingReview, setEnablingReview] = useState(false);

	const load = useCallback(
		async (nextPeriod: ReflectPeriod) => {
			setLoading(true);
			setError(null);
			try {
				setDashboard(await getReflectDashboard(target, nextPeriod));
			} catch (nextError) {
				setError(nextError);
			} finally {
				setLoading(false);
			}
		},
		[target]
	);

	useEffect(() => {
		void load(period);
		let cancelled = false;
		getReflectSettings(target)
			.then((next) => {
				if (!cancelled) {
					setSettings(next);
				}
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) {
					setSettingsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [load, period, target]);

	const turnOnUsageReview = async () => {
		setEnablingReview(true);
		try {
			if (!(await enableUsageReview(target))) {
				throw new Error("Usage review stayed off");
			}
			await load(period);
		} catch {
			toast.error("Usage review couldn't be turned on", {
				description: "Check the active node connection and try again.",
			});
		} finally {
			setEnablingReview(false);
		}
	};

	const changePeriod = (next: string | null) => {
		if (!next) {
			return;
		}
		const value =
			/* SAFETY: The native includes comparison below checks the unchanged search value against REFLECT_PERIODS before it reaches setPeriod; this assertion alone makes no membership claim. */ next as ReflectPeriod;
		if (REFLECT_PERIODS.includes(value)) {
			setPeriod(value);
		}
	};

	const updateSetting = async (patch: Partial<ReflectSettings>) => {
		const previous = settings;
		setSettings((current) => ({ ...current, ...patch }));
		try {
			setSettings(await updateReflectSettings(target, patch));
		} catch {
			setSettings(previous);
			toast.error("Reflect settings couldn't be saved", {
				description: "Your node may not support these controls yet.",
			});
		}
	};

	const hourOptions = Array.from({ length: 24 }, (_, hour) => (
		<SelectItem key={hour} value={String(hour)}>
			{formatHour(hour)}
		</SelectItem>
	));

	const hourItems = Array.from({ length: 24 }, (_, hour) => ({
		label: formatHour(hour),
		value: String(hour),
	}));

	return (
		<div className="flex w-full flex-col">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<h2 className="font-semibold text-lg tracking-tight">Reflect</h2>
					<p className="text-detail text-muted-foreground">
						Patterns, topics and observations from your time with Ryu.
					</p>
				</div>
				<div className="flex items-center gap-1">
					<Select
						items={REFLECT_PERIODS.map((value) => ({
							label: PERIOD_LABELS[value],
							value,
						}))}
						onValueChange={changePeriod}
						value={period}
					>
						<SelectTrigger aria-label="Reflect period" className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{REFLECT_PERIODS.map((value) => (
								<SelectItem key={value} value={value}>
									{PERIOD_LABELS[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						aria-label="Refresh Reflect"
						disabled={loading}
						onClick={() => void load(period)}
						size="icon-sm"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					</Button>
				</div>
			</div>

			{error && isUnsupported(error) ? (
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyTitle>Reflect is not available on this node yet</EmptyTitle>
						<EmptyDescription>
							Update Core to turn on the Reflect dashboard.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							onClick={() => void load(period)}
							size="sm"
							variant="outline"
						>
							Try again
						</Button>
					</EmptyContent>
				</Empty>
			) : loading ? (
				<div className="pt-6">
					<SkeletonRows />
				</div>
			) : error && isUsageReviewDisabled(error) ? (
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyTitle>Reflect needs usage review</EmptyTitle>
						<EmptyDescription>
							Usage review lets this node summarize your activity when you open
							Reflect. It adds no background capture and no model call.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							disabled={enablingReview}
							onClick={() => void turnOnUsageReview()}
							size="sm"
							variant="outline"
						>
							Turn on usage review
						</Button>
					</EmptyContent>
				</Empty>
			) : error ? (
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyTitle>Reflect couldn't load</EmptyTitle>
						<EmptyDescription>
							Check the active node connection and try again.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button
							onClick={() => void load(period)}
							size="sm"
							variant="outline"
						>
							Try again
						</Button>
					</EmptyContent>
				</Empty>
			) : dashboard ? (
				<>
					<div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
						{dashboard.activity.map((activity) => (
							<Stat activity={activity} key={activity.label} />
						))}
					</div>

					<SectionTitle>Topics that surfaced</SectionTitle>
					{dashboard.topics.length ? (
						<ul>
							{dashboard.topics.map((topic) => (
								<li
									className="flex min-h-12 items-center justify-between gap-6 border-border border-b py-3 last:border-b-0"
									key={topic.name}
								>
									<div className="min-w-0">
										<p className="text-sm">{topic.name}</p>
										{topic.summary ? (
											<p className="truncate text-detail text-muted-foreground">
												{topic.summary}
											</p>
										) : null}
									</div>
									<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
										{formatNumber(topic.count)}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-detail text-muted-foreground">
							No recurring topics in this period yet.
						</p>
					)}

					<SectionTitle>Insights</SectionTitle>
					{dashboard.insights.length ? (
						<ul>
							{dashboard.insights.map((insight) => (
								<li
									className="border-border border-b py-3 last:border-b-0"
									key={insight.id}
								>
									<p className="text-sm">{insight.title}</p>
									<p className="text-detail text-muted-foreground">
										{insight.body}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-detail text-muted-foreground">
							Insights appear once Reflect sees enough activity.
						</p>
					)}
				</>
			) : null}

			<SectionTitle>Gentle reminders</SectionTitle>
			<div className="flex min-h-12 items-center justify-between gap-6 border-border border-b py-3">
				<div className="min-w-0">
					<Label htmlFor="reflect-break-nudges">Break nudges</Label>
					<p className="text-detail text-muted-foreground">
						Saved on this node. Ryu doesn't send break reminders yet.
					</p>
				</div>
				<Switch
					checked={settings.breakNudges}
					disabled={settingsLoading}
					id="reflect-break-nudges"
					onCheckedChange={(checked) =>
						void updateSetting({ breakNudges: checked })
					}
				/>
			</div>
			<div className="flex min-h-12 items-center justify-between gap-6 border-border border-b py-3">
				<div className="min-w-0">
					<Label htmlFor="reflect-quiet-hours">Quiet hours</Label>
					<p className="text-detail text-muted-foreground">
						Dream and Reflect won't interrupt you during this window.
					</p>
				</div>
				<Switch
					checked={settings.quietHoursEnabled}
					disabled={settingsLoading}
					id="reflect-quiet-hours"
					onCheckedChange={(checked) =>
						void updateSetting({ quietHoursEnabled: checked })
					}
				/>
			</div>
			<div className="grid gap-3 py-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="reflect-quiet-start">Quiet hours start</Label>
					<Select
						items={hourItems}
						onValueChange={(value) =>
							void updateSetting({ quietHoursStart: Number(value) })
						}
						value={String(settings.quietHoursStart)}
					>
						<SelectTrigger
							disabled={!settings.quietHoursEnabled}
							id="reflect-quiet-start"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>{hourOptions}</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="reflect-quiet-end">Quiet hours end</Label>
					<Select
						items={hourItems}
						onValueChange={(value) =>
							void updateSetting({ quietHoursEnd: Number(value) })
						}
						value={String(settings.quietHoursEnd)}
					>
						<SelectTrigger
							disabled={!settings.quietHoursEnabled}
							id="reflect-quiet-end"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>{hourOptions}</SelectContent>
					</Select>
				</div>
			</div>
		</div>
	);
}
