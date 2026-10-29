import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import {
	WallpaperPicker,
	WallpaperPreview,
} from "../wallpaper/WallpaperPicker.tsx";

export const OS_HOME_SETTINGS = [
	{
		key: "intro",
		label: "Welcome text",
		description: "Show a short welcome for five seconds when you enter OS.",
		defaultValue: true,
	},
	{
		key: "clock",
		label: "Clock",
		description: "Show the current time on your desktop.",
		defaultValue: true,
	},
	{
		key: "date",
		label: "Date",
		description: "Show the day and date on your desktop.",
		defaultValue: true,
	},
	{
		key: "seconds",
		label: "Seconds",
		description: "Include seconds while the clock is visible.",
		defaultValue: false,
	},
	{
		key: "24-hour",
		label: "24-hour time",
		description: "Use 00:00–23:59 instead of AM and PM.",
		defaultValue: false,
	},
] as const;

function HomeSetting({
	setting,
}: {
	setting: (typeof OS_HOME_SETTINGS)[number];
}) {
	const [value, setValue] = usePersistedToggle(
		`ryu:os-home:${setting.key}`,
		setting.defaultValue
	);
	return (
		<div className="flex items-center justify-between gap-6 py-3">
			<span>
				<span className="block font-medium text-sm">{setting.label}</span>
				<span className="mt-1 block text-muted-foreground text-xs">
					{setting.description}
				</span>
			</span>
			<Switch
				aria-label={setting.label}
				checked={value}
				onCheckedChange={setValue}
			/>
		</div>
	);
}

export function OsHomeSettings({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Customize desktop</DialogTitle>
					<DialogDescription>
						Choose your wallpaper and what appears on the OS home. Your choices
						are saved on this device.
					</DialogDescription>
				</DialogHeader>
				<section className="space-y-3">
					<h3 className="font-medium text-sm">Wallpaper</h3>
					<WallpaperPreview />
					<WallpaperPicker />
				</section>
				<h3 className="font-medium text-sm">Home</h3>
				<div className="divide-y divide-border/50">
					{OS_HOME_SETTINGS.map((setting) => (
						<HomeSetting key={setting.key} setting={setting} />
					))}
				</div>
				<p className="text-muted-foreground text-xs">
					The clock follows your display time zone in Settings → Appearance →
					Date &amp; time.
				</p>
			</DialogContent>
		</Dialog>
	);
}

export function OsHome({ visible }: { visible: boolean }) {
	const [intro] = usePersistedToggle("ryu:os-home:intro", true);
	const [clock] = usePersistedToggle("ryu:os-home:clock", true);
	const [date] = usePersistedToggle("ryu:os-home:date", true);
	const [seconds] = usePersistedToggle("ryu:os-home:seconds", false);
	const [hour24] = usePersistedToggle("ryu:os-home:24-hour", false);
	const [welcomeVisible, setWelcomeVisible] = useState(true);
	const [now, setNow] = useState(() => Date.now());
	useTimezoneRevision();
	useEffect(() => {
		const timeout = window.setTimeout(() => setWelcomeVisible(false), 5000);
		return () => window.clearTimeout(timeout);
	}, []);
	useEffect(() => {
		if (!(visible && (clock || date))) {
			return;
		}
		let timeout: ReturnType<typeof setTimeout>;
		const period = clock && seconds ? 1000 : 60_000;
		const tick = () => {
			const current = Date.now();
			setNow(current);
			timeout = setTimeout(tick, period - (current % period));
		};
		const resume = () => {
			clearTimeout(timeout);
			if (!document.hidden) {
				tick();
			}
		};
		resume();
		document.addEventListener("visibilitychange", resume);
		return () => {
			clearTimeout(timeout);
			document.removeEventListener("visibilitychange", resume);
		};
	}, [clock, date, seconds, visible]);
	if (!visible) {
		return null;
	}
	return (
		<div
			className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 pb-28 text-center"
			data-testid="os-home"
		>
			{clock && (
				<time
					className="font-light text-7xl text-white/90 tabular-nums tracking-tight drop-shadow-lg sm:text-8xl"
					data-testid="os-home-clock"
					dateTime={new Date(now).toISOString()}
				>
					{formatDateTime(now, {
						hour: "numeric",
						minute: "2-digit",
						second: seconds ? "2-digit" : undefined,
						hourCycle: hour24 ? "h23" : "h12",
					})}
				</time>
			)}
			{date && (
				<p
					className="text-lg text-white/75 drop-shadow-md"
					data-testid="os-home-date"
				>
					{formatDateTime(now, {
						weekday: "long",
						month: "long",
						day: "numeric",
					})}
				</p>
			)}
			{intro && (
				<p
					aria-hidden={!welcomeVisible}
					className="absolute inset-x-6 top-2/3 text-sm text-white/65 transition-opacity duration-500 data-[welcome-visible=false]:opacity-0 data-[welcome-visible=true]:opacity-100 motion-reduce:transition-none"
					data-testid="os-home-intro"
					data-welcome-visible={welcomeVisible}
				>
					Welcome to OS. Open an app from the dock to get started.
				</p>
			)}
		</div>
	);
}
