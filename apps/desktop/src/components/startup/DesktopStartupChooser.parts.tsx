import {
	ArrowRight02Icon,
	Image01Icon,
	ShuffleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useEffect, useState } from "react";
import type { listAccounts } from "@/lib/auth-client.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { useWallpaper } from "@/src/lib/wallpaper.ts";
import {
	WallpaperPicker,
	WallpaperPreview,
} from "../wallpaper/WallpaperPicker.tsx";
import sceneStyles from "./startup-glass.module.css";

export type AccountView = ReturnType<typeof listAccounts>[number];

export type StartupStep = "account" | "node";

/**
 * Liquid-glass surface in the macOS 27 style: a frosted, saturated backdrop,
 * a bright specular rim on top, a faint inner shadow below, and a soft drop
 * shadow. CSS only, so it renders the same in WebView2 and WKWebView.
 */
export const GLASS = cn(
	"border border-white/25 bg-white/[0.12]",
	sceneStyles.glass
);

export const GLASS_HOVER =
	"transition-[background-color,scale] hover:bg-white/[0.2] active:scale-[0.97] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80";

export const TEXT_SHADOW = sceneStyles.textShadow;

export function accountLabel(account: AccountView): string {
	if (account.isAnonymous) {
		return "Guest";
	}
	return account.name || account.email || "Account";
}

/** The date and big glass clock at the top, like the macOS login window. */
export function LoginClock() {
	const [hour24] = usePersistedToggle("ryu:os-home:24-hour", false);
	const [now, setNow] = useState(() => Date.now());
	useTimezoneRevision();
	useEffect(() => {
		let timeout: ReturnType<typeof setTimeout>;
		const tick = () => {
			const current = Date.now();
			setNow(current);
			timeout = setTimeout(tick, 60_000 - (current % 60_000));
		};
		tick();
		return () => clearTimeout(timeout);
	}, []);
	const time = formatDateTime(now, {
		hour: "numeric",
		minute: "2-digit",
		hourCycle: hour24 ? "h23" : "h12",
	}).replace(/\s?[AP]M$/i, "");
	return (
		<div
			className="pointer-events-none flex flex-col items-center"
			data-testid="startup-clock"
		>
			<p
				className={cn(
					"font-semibold text-white/90 text-xl tracking-tight",
					TEXT_SHADOW
				)}
			>
				{formatDateTime(now, {
					weekday: "short",
					month: "short",
					day: "numeric",
				})}
			</p>
			<time
				className="relative font-semibold tabular-nums leading-none"
				data-startup-title=""
				dateTime={new Date(now).toISOString()}
			>
				{/* Liquid-glass numerals: a tinted fill with a bright top edge and a
				    soft refraction shadow underneath. */}
				<span
					aria-hidden="true"
					className="absolute inset-0 translate-y-[3px] text-black/35 blur-sm"
					data-startup-title-glow=""
				>
					{time}
				</span>
				<span
					className="relative bg-clip-text text-transparent [-webkit-text-stroke:1px_rgba(255,255,255,0.5)]"
					data-startup-title-gradient=""
				>
					{time}
				</span>
			</time>
		</div>
	);
}

/** One selectable login-window entry: a round glass tile with a name below. */
export function LoginTile({
	disabled = false,
	children,
	label,
	onClick,
	onDoubleClick,
	selected,
}: {
	disabled?: boolean;
	children: ReactNode;
	label: string;
	onClick: () => void;
	onDoubleClick?: () => void;
	selected: boolean;
}) {
	return (
		<button
			aria-checked={selected}
			className={cn(
				"group flex w-32 flex-col items-center gap-2.5 rounded-2xl p-2 outline-none transition-[opacity,scale] duration-300 focus-visible:ring-2 focus-visible:ring-white/80 motion-reduce:transition-none",
				selected
					? "scale-100 opacity-100"
					: "scale-[0.92] opacity-70 hover:opacity-95"
			)}
			disabled={disabled}
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			role="radio"
			type="button"
		>
			<span
				className={cn(
					"flex size-20 items-center justify-center overflow-hidden rounded-full p-1",
					GLASS,
					selected && "bg-white/25 ring-2 ring-white/70"
				)}
			>
				{children}
			</span>
			<span
				className={cn(
					"max-w-full truncate font-semibold text-sm text-white",
					TEXT_SHADOW
				)}
				title={label}
			>
				{label}
			</span>
		</button>
	);
}

export function DefaultSwitch({
	disabled = false,
	id,
	checked,
	onCheckedChange,
}: {
	disabled?: boolean;
	id: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-center gap-2">
			<label
				className={cn("font-medium text-white/85 text-xs", TEXT_SHADOW)}
				htmlFor={id}
			>
				Use as default
			</label>
			<Switch
				aria-label="Use as default"
				checked={checked}
				disabled={disabled}
				id={id}
				onCheckedChange={onCheckedChange}
				size="sm"
			/>
		</div>
	);
}

/** The glass pill that stands in for the macOS password field. */
export function ContinueButton({
	busy,
	disabled,
	label,
	onClick,
}: {
	busy: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"flex h-10 min-w-56 items-center justify-between gap-3 rounded-full pr-1 pl-5 font-medium text-sm text-white disabled:opacity-50",
				GLASS,
				GLASS_HOVER
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{label}
			<span className="flex size-8 items-center justify-center rounded-full bg-white/25">
				{busy ? (
					<Spinner className="size-4" />
				) : (
					<HugeiconsIcon
						aria-hidden="true"
						className="size-4"
						icon={ArrowRight02Icon}
					/>
				)}
			</span>
		</button>
	);
}

export function moveSelection<T>(
	items: readonly T[],
	current: T | undefined,
	delta: number
): T | undefined {
	if (items.length === 0) {
		return current;
	}
	const index = current === undefined ? -1 : items.indexOf(current);
	const next = (index + delta + items.length) % items.length;
	return items[next];
}

export function WallpaperButton() {
	const { shuffle } = useWallpaper();
	return (
		<div className="flex items-center gap-2" data-tauri-drag-region={false}>
			<button
				aria-label="Shuffle wallpaper"
				className={cn(
					"flex size-9 items-center justify-center rounded-full text-white",
					GLASS,
					GLASS_HOVER
				)}
				onClick={shuffle}
				title="Shuffle wallpaper"
				type="button"
			>
				<HugeiconsIcon className="size-4" icon={ShuffleIcon} />
			</button>
			<Popover>
				<PopoverTrigger
					aria-label="Choose wallpaper"
					variant="startup-wallpaper"
				>
					<HugeiconsIcon className="size-4" icon={Image01Icon} />
					Wallpaper
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="max-h-[min(40rem,75vh)] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto"
				>
					<WallpaperPreview />
					<WallpaperPicker />
				</PopoverContent>
			</Popover>
		</div>
	);
}
