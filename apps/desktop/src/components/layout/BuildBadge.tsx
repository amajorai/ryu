// A small badge pinned in the sidebar header that surfaces the build's active
// identity: a "Dev" pill when this is the dev variant (RYU_PROFILE=dev / the
// "Ryu Dev" build), and the selected release channel when it is not Stable
// (Canary / Nightly / Beta). A plain Stable release build shows nothing, so the
// header stays clean for the common case. Clicking opens Settings → Updates,
// where the channel is chosen.

import { useBuildProfile } from "@/src/lib/build-profile.ts";
import { useReleaseChannel } from "@/src/lib/release-channel.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

const CHANNEL_LABELS: Record<string, string> = {
	canary: "Canary",
	nightly: "Nightly",
	beta: "Beta",
	stable: "Stable",
};

// Per-state tint. Kept as full class strings (not interpolated) so Tailwind's
// content scanner keeps them.
const DEV_CLASS =
	"bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30";
const CHANNEL_CLASS: Record<string, string> = {
	canary: "bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-rose-500/30",
	nightly:
		"bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 ring-indigo-500/30",
	beta: "bg-sky-500/15 text-sky-600 dark:text-sky-400 ring-sky-500/30",
};

function Pill({
	className,
	label,
	onClick,
	title,
}: {
	className: string;
	label: string;
	onClick: () => void;
	title: string;
}) {
	return (
		<button
			aria-label={title}
			className={`inline-flex h-5 items-center rounded-full px-2 font-medium text-[10px] uppercase leading-none tracking-wide ring-1 ring-inset transition-opacity hover:opacity-80 ${className}`}
			onClick={onClick}
			title={title}
			type="button"
		>
			{label}
		</button>
	);
}

/** Build-identity badges for the sidebar header. Renders nothing on a plain
 *  Stable release build. */
export function BuildBadge({ className }: { className?: string } = {}) {
	const { dev } = useBuildProfile();
	const [channel] = useReleaseChannel();
	const openSettings = useSettingsDialog((s) => s.openSettings);

	const showChannel = channel !== "stable";
	if (!(dev || showChannel)) {
		return null;
	}

	const open = () => openSettings("updates");

	return (
		<div className={`flex items-center gap-1 ${className ?? ""}`}>
			{dev && (
				<Pill
					className={DEV_CLASS}
					label="Dev"
					onClick={open}
					title="Dev build — isolated from your release install"
				/>
			)}
			{showChannel && (
				<Pill
					className={CHANNEL_CLASS[channel] ?? DEV_CLASS}
					label={CHANNEL_LABELS[channel] ?? channel}
					onClick={open}
					title={`Release channel: ${CHANNEL_LABELS[channel] ?? channel}`}
				/>
			)}
		</div>
	);
}
