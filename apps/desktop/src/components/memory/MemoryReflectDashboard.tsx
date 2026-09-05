import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import {
	Activity,
	ArrowUpRight,
	CalendarDays,
	Clock3,
	Lightbulb,
	PauseCircle,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	getReflectDashboard,
	getReflectSettings,
	REFLECT_PERIODS,
	type ReflectDashboard,
	type ReflectPeriod,
	type ReflectSettings,
	updateReflectSettings,
} from "@/src/lib/api/memory.ts";

const PERIOD_LABELS: Record<ReflectPeriod, string> = {
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
};

function isUnsupported(error: unknown): boolean {
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

const EMPTY_SETTINGS: ReflectSettings = {
	breakNudges: true,
	quietHoursEnabled: true,
	quietHoursEnd: 8,
	quietHoursStart: 22,
};

function StatCard({
	activity,
}: {
	activity: ReflectDashboard["activity"][number];
}) {
	const trend = formatTrend(activity.trend);
	return (
		<Card className="border-border/70 shadow-none">
			<CardContent className="flex items-start justify-between gap-3 pt-5">
				<div>
					<p className="text-muted-foreground text-xs">{activity.label}</p>
					<p className="mt-1 font-medium text-2xl tracking-tight">
						{formatNumber(activity.count)}
					</p>
				</div>
				<div className="rounded-full bg-primary/10 p-2 text-primary">
					<Activity className="size-4" />
				</div>
				{trend ? (
					<Badge className="absolute mt-10" variant="secondary">
						<ArrowUpRight className="size-3" />
						{trend}
					</Badge>
				) : null}
			</CardContent>
		</Card>
	);
}

export function MemoryReflectDashboard({ target }: { target: ApiTarget }) {
	const [period, setPeriod] = useState<ReflectPeriod>("7d");
	const [dashboard, setDashboard] = useState<ReflectDashboard | null>(null);
	const [settings, setSettings] = useState<ReflectSettings>(EMPTY_SETTINGS);
	const [loading, setLoading] = useState(true);
	const [settingsLoading, setSettingsLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);

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

	const changePeriod = (next: string | null) => {
		if (!next) {
			return;
		}
		const value = next as ReflectPeriod;
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

	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<CalendarDays className="size-5 text-primary" />
						<h1 className="font-medium text-lg">Reflect</h1>
					</div>
					<p className="mt-1 max-w-xl text-muted-foreground text-sm">
						A quiet look at how you spent time with Ryu — patterns, topics, and
						a few useful observations.
					</p>
				</div>
				<div className="flex items-center gap-2">
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
						size="icon"
						variant="ghost"
					>
						<RefreshCw className="size-4" />
					</Button>
				</div>
			</div>

			{error && isUnsupported(error) ? (
				<Empty className="border border-dashed py-12">
					<EmptyHeader>
						<EmptyTitle>Reflect is not available on this node yet</EmptyTitle>
						<EmptyDescription>
							Update Core to enable the Reflect dashboard. The desktop is ready
							for the API at <code>/api/memory/reflect</code>.
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => void load(period)} variant="ghost">
						Try again
					</Button>
				</Empty>
			) : loading ? (
				<div className="flex justify-center py-16">
					<Spinner />
				</div>
			) : error ? (
				<Empty className="border border-dashed py-12">
					<EmptyHeader>
						<EmptyTitle>Reflect couldn't load</EmptyTitle>
						<EmptyDescription>
							Check the active node connection and try again.
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => void load(period)} variant="ghost">
						Try again
					</Button>
				</Empty>
			) : dashboard ? (
				<>
					<div className="grid gap-3 sm:grid-cols-3">
						{dashboard.activity.map((activity) => (
							<StatCard activity={activity} key={activity.label} />
						))}
					</div>

					<div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
						<Card className="border-border/70 shadow-none">
							<CardHeader>
								<CardTitle>Topics that surfaced</CardTitle>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{dashboard.topics.length ? (
									dashboard.topics.map((topic) => (
										<div
											className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3"
											key={topic.name}
										>
											<div className="min-w-0">
												<p className="font-medium text-sm">{topic.name}</p>
												{topic.summary ? (
													<p className="mt-1 text-muted-foreground text-xs">
														{topic.summary}
													</p>
												) : null}
											</div>
											<Badge variant="secondary">
												{formatNumber(topic.count)}
											</Badge>
										</div>
									))
								) : (
									<p className="text-muted-foreground text-sm">
										No recurring topics in this period yet.
									</p>
								)}
							</CardContent>
						</Card>

						<Card className="border-border/70 shadow-none">
							<CardHeader>
								<CardTitle className="flex items-center gap-2">
									<Lightbulb className="size-4 text-primary" />
									Insights
								</CardTitle>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{dashboard.insights.length ? (
									dashboard.insights.map((insight) => (
										<div
											className="rounded-lg bg-muted/45 p-3"
											key={insight.id}
										>
											<p className="font-medium text-sm">{insight.title}</p>
											<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
												{insight.body}
											</p>
										</div>
									))
								) : (
									<p className="text-muted-foreground text-sm">
										Insights will appear as Reflect sees enough activity.
									</p>
								)}
							</CardContent>
						</Card>
					</div>
				</>
			) : null}

			<Card className="border-border/70 shadow-none">
				<CardHeader>
					<CardTitle>Gentle reminders</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-start gap-3">
							<PauseCircle className="mt-0.5 size-4 text-muted-foreground" />
							<div>
								<Label htmlFor="reflect-break-nudges">Break nudges</Label>
								<p className="mt-1 text-muted-foreground text-xs">
									Occasional reminders to step away after a long stretch.
								</p>
							</div>
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
					<div className="flex flex-wrap items-center justify-between gap-3 border-border/60 border-t pt-4">
						<div className="flex items-start gap-3">
							<Clock3 className="mt-0.5 size-4 text-muted-foreground" />
							<div>
								<Label htmlFor="reflect-quiet-hours">Quiet hours</Label>
								<p className="mt-1 text-muted-foreground text-xs">
									Dream and Reflect won't interrupt you during this window.
								</p>
							</div>
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
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="reflect-quiet-start">Quiet hours start</Label>
							<Select
								items={Array.from({ length: 24 }, (_, hour) => ({
									label: formatHour(hour),
									value: String(hour),
								}))}
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
								items={Array.from({ length: 24 }, (_, hour) => ({
									label: formatHour(hour),
									value: String(hour),
								}))}
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
				</CardContent>
			</Card>
		</div>
	);
}
