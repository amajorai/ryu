// The interactions proof drives the Compute and Share header buttons, which are
// held behind the `ui.compute_share` rollout flag. The harness has no control
// plane to read flags from, so it switches that one on and leaves the rest of
// the module unchanged.
import { COMPUTE_SHARE_FLAG } from "@ryu/auth/lib/feature-flags";
import { useFeatureFlag as useServedFeatureFlag } from "../../src/hooks/useFeatureFlag.ts";

export type {
	FeatureFlagState,
	StoreListing,
} from "../../src/hooks/useFeatureFlag.ts";
export {
	useAppListingAllowed,
	useFeatureFlagState,
	useStoreListingAllowed,
} from "../../src/hooks/useFeatureFlag.ts";

export function useFeatureFlag(key: string): boolean {
	const served = useServedFeatureFlag(key);
	return key === COMPUTE_SHARE_FLAG || served;
}
