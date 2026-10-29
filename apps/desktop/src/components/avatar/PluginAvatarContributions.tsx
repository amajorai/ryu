import { AvatarContributionsProvider } from "@ryu/ui/components/avatar-contributions.tsx";
import type { AvatarContributions } from "@ryu/ui/components/avatar-parts.ts";
import { type ReactNode, useMemo } from "react";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";

/**
 * Hand enabled plugins' avatar accessories and styles to every shared avatar
 * renderer and editor in the shell. Disabling a plugin drops its parts here, and
 * any avatar still wearing one renders its plain fallback until it comes back.
 */
export function PluginAvatarContributions({
	children,
}: {
	children: ReactNode;
}) {
	const { avatar_accessories, avatar_styles } = usePluginContributions();
	const value = useMemo<AvatarContributions>(
		() => ({ accessories: avatar_accessories, styles: avatar_styles }),
		[avatar_accessories, avatar_styles]
	);
	return (
		<AvatarContributionsProvider value={value}>
			{children}
		</AvatarContributionsProvider>
	);
}
