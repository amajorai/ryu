// Build identity in the account menu header: plain muted text ("Dev",
// "Nightly"), not a chip in the footer. Selecting it opens Gateway → Updates.
// Hidden on a plain Stable release.

import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { useBuildProfile } from "@/src/lib/build-profile.ts";
import { channelLabel } from "@/src/lib/channel-brand.ts";
import { useReleaseChannel } from "@/src/lib/release-channel.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

/** Build-identity row for the account menu. Renders nothing on Stable. */
export function BuildBadge() {
	const { dev } = useBuildProfile();
	const [channel] = useReleaseChannel();
	const openGateway = useGatewayDialog((s) => s.openGateway);

	const showChannel = channel !== "stable";
	if (!(dev || showChannel)) {
		return null;
	}

	const labels = [
		...(dev ? ["Dev"] : []),
		// Same label table that names the shipped bundle, so this row and the
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
		<DropdownMenuItem
			aria-label={title}
			className="text-xs"
			onClick={() => openGateway("updates")}
			title={title}
			tone="muted"
		>
			{labels.join(" · ")}
		</DropdownMenuItem>
	);
}
