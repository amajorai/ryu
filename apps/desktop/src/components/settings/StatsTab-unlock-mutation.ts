import { useLiteralMessages } from "@ryu/i18n/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import { unlockFeature } from "@/src/lib/api/profile.ts";
import { playSound } from "@/src/lib/sounds/play-sound.ts";
import { formatNumber } from "./StatsTab-format.ts";

/**
 * Spend points on a feature unlock. A success refreshes the catalog and the
 * balance, toasts the remaining points and plays the achievement cue beside
 * the toast; a refusal toasts the server's reason and stays silent.
 */
export function useUnlockFeatureMutation() {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: unlockFeature,
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: ["profile", "unlocks"] });
			queryClient.invalidateQueries({ queryKey: ["profile", "me"] });
			sileo.success({
				title: "Feature unlocked",
				description: tl("{points} points remaining", {
					points: formatNumber(result.pointsBalance),
				}),
			});
			playSound("achievement", { gesture: true });
		},
		onError: (error) =>
			sileo.error({
				title: error instanceof Error ? error.message : "Failed to unlock",
			}),
	});
}
