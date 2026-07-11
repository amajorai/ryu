/* @jsxImportSource @opentui/react */
// Bottom key-hint bar, mirroring apps/cli's footer. The shell renders a base bar
// with the global hints; the active tab can supply its own hints which are merged
// in. Each hint is a {keys, label} pair shown as "keys label" segments.

import { useTheme } from "@/components/ui/theme-provider.tsx";

export interface KeyHint {
	keys: string;
	label: string;
}

export function StatusBar({
	hints,
	left,
}: {
	hints: KeyHint[];
	/** Optional left-aligned status text (e.g. node url, streaming state). */
	left?: string;
}) {
	const theme = useTheme();
	return (
		<box
			backgroundColor={theme.colors.muted}
			flexDirection="row"
			justifyContent="space-between"
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.mutedForeground}>{left ?? ""}</text>
			<box flexDirection="row" gap={2}>
				{hints.map((hint) => (
					<box flexDirection="row" gap={1} key={hint.keys}>
						<text fg={theme.colors.primary}>{hint.keys}</text>
						<text fg={theme.colors.mutedForeground}>{hint.label}</text>
					</box>
				))}
			</box>
		</box>
	);
}
