/* @jsxImportSource @opentui/react */
// Placeholder shown for tabs not yet built. The integration step swaps each
// registry entry's Component for the real tab module; until then this renders a
// themed "coming soon" panel so the shell is fully navigable. Builders do NOT edit
// this file - they create src/tabs/<name>.tsx and the integration step wires it in.

import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { TabProps } from "./types.ts";

export function makePlaceholder(title: string) {
	return function Placeholder(_props: TabProps) {
		const theme = useTheme();
		return (
			<box flexDirection="column" flexGrow={1} padding={1}>
				<Card subtitle="Tab not yet implemented" title={title}>
					<text fg={theme.colors.mutedForeground}>
						This surface is being built. The shell, theme, Core client, and the
						shared list/loading/error primitives are ready - drop a real
						src/tabs/{title.toLowerCase()}.tsx module in to replace this.
					</text>
				</Card>
			</box>
		);
	};
}
