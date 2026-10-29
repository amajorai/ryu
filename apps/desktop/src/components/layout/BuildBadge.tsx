// Build-identity chip in the sidebar footer: a compact pulsed div (not a tiny
// badge). Clicking opens Gateway → Updates. Hidden on a plain Stable release.

import { BorderBeam } from "@ryu/ui/components/border-beam.tsx";
import { useTheme } from "next-themes";
import { useBuildProfile } from "@/src/lib/build-profile.ts";
import { channelLabel } from "@/src/lib/channel-brand.ts";
import { useReleaseChannel } from "@/src/lib/release-channel.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

/** Pulsed build-identity chip. Renders nothing on a plain Stable release build. */
export function BuildBadge({ className }: { className?: string } = {}) {
	const { resolvedTheme } = useTheme();
	const beamTheme = resolvedTheme === "light" ? "light" : "dark";
	const { dev } = useBuildProfile();
	const [channel] = useReleaseChannel();
	const openGateway = useGatewayDialog((s) => s.openGateway);

	const showChannel = channel !== "stable";
	if (!(dev || showChannel)) {
		return null;
	}

	const labels = [
		...(dev ? ["Dev"] : []),
		// Same label table that names the shipped bundle, so the chip and the
		// app's own name agree on what a channel is called.
		...(showChannel ? [channelLabel(channel)] : []),
	];
	const title = labels
		.map((label) =>
			label === "Dev"
				? "Dev build — isolated from your release install"
				: `Release channel: ${label}`
		)
		.join(" · ");

	return (
		<BorderBeam
			borderRadius={999}
			className={`inline-flex shrink-0 ${className ?? ""}`}
			colorVariant="colorful"
			size="pulse-inner"
			strength={0.7}
			theme={beamTheme}
		>
			<button
				aria-label={title}
				className="inline-flex h-5 items-center gap-1.5 rounded-full bg-muted px-2 transition-opacity hover:opacity-80"
				onClick={() => openGateway("updates")}
				title={title}
				type="button"
			>
				{labels.map((label) => (
					<span
						className="type-compact font-medium text-foreground uppercase leading-none tracking-wide"
						key={label}
					>
						{label}
					</span>
				))}
			</button>
		</BorderBeam>
	);
}
