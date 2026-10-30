import type { NormalizedRecommendations } from "@ryu/marketplace/catalog/recommendations";
import { normalizeRecommendations } from "@ryu/marketplace/catalog/recommendations";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import {
	type GatewayConfigPatch,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

const wireResponseSchema = z.looseObject({
	cadence: z.string().optional(),
	enabled: z.boolean().optional(),
	hidden: z.boolean().optional(),
	items: gatewayJsonValueSchema.optional(),
});

/** The Home "For you" recommendations query plus its refresh/hide/cadence
 *  writes, each of which invalidates the same query key. */
export function useStoreHomeRecommendations(target: ApiTarget, url: string) {
	const recommendationsQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["store-home", "recommendations", url],
				queryFn: async () => {
					const wire = await request(
						target,
						"/api/marketplace/recommendations",
						undefined,
						wireResponseSchema
					);
					return normalizeRecommendations(wire);
				},
				staleTime: 5 * 60 * 1000,
			}),
			[target, url]
		)
	);

	const qc = useQueryClient();
	const recommendationData =
		recommendationsQuery.data ?? normalizeRecommendations(undefined);
	const refreshRecommendations = useCallback(async () => {
		try {
			await request(
				target,
				"/api/marketplace/recommendations?refresh=true",
				{ method: "POST" },
				wireResponseSchema
			);
			await qc.invalidateQueries({
				queryKey: ["store-home", "recommendations", url],
			});
		} catch {
			// Recommendations are an enhancement; the rest of Home remains usable.
		}
	}, [qc, target, url]);
	const setRecommendationHidden = useCallback(
		async (hidden: boolean) => {
			try {
				await request(
					target,
					"/api/marketplace/recommendations/preference",
					{
						body: { hidden },
						method: "PUT",
					},
					gatewayJsonValueSchema
				);
				await qc.invalidateQueries({
					queryKey: ["store-home", "recommendations", url],
				});
			} catch {
				// A hidden preference failing should not interrupt Store navigation.
			}
		},
		[qc, target, url]
	);
	const setRecommendationCadence = useCallback(
		async (cadence: NormalizedRecommendations["cadence"]) => {
			const patch: GatewayConfigPatch = {
				marketplace_recommendations: {
					cadence,
					enabled: recommendationData.enabled,
				},
			};
			try {
				await updateGatewayConfig(target, patch);
				await qc.invalidateQueries({
					queryKey: ["store-home", "recommendations", url],
				});
			} catch {
				// Gateway policy remains authoritative if this node is temporarily down.
			}
		},
		[qc, recommendationData.enabled, target, url]
	);
	return {
		recommendationData,
		recommendationsQuery,
		refreshRecommendations,
		setRecommendationCadence,
		setRecommendationHidden,
	};
}
