import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { request, toTarget } from "@/src/lib/api/client.ts";
import {
	type ComposioBillingPolicy,
	ComposioBillingView,
} from "./composio-billing-view.tsx";

const composioBillingActiveResponseSchema = z.looseObject({
	baa: z.boolean(),
	ipAllowlist: z.boolean(),
	zeroDataRetention: z.boolean(),
});
const ComposioBillingSettingsResponseSchema = z.looseObject({
	composioBillingActive: composioBillingActiveResponseSchema.optional(),
});

const EMPTY_POLICY: ComposioBillingPolicy = {
	zeroDataRetention: false,
	baa: false,
	ipAllowlist: false,
};

export function ComposioBillingSettings() {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const [policy, setPolicy] = useState(EMPTY_POLICY);
	const [loading, setLoading] = useState(true);
	const [unavailable, setUnavailable] = useState(false);
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		request(
			target,
			"/api/gateway/config",
			undefined,
			ComposioBillingSettingsResponseSchema
		)
			.then((config) => {
				if (!cancelled) {
					setPolicy(config.composioBillingActive ?? EMPTY_POLICY);
					setUnavailable(!config.composioBillingActive);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setUnavailable(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);
	return (
		<ComposioBillingView loading={loading || unavailable} policy={policy} />
	);
}
