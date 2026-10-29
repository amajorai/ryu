import { COMPUTE_SHARE_FLAG } from "@ryu/auth/lib/feature-flags";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import {
	type ComputeShareMode,
	ComputeShareSurface,
} from "@/src/components/exchange/ComputeShareSurface.tsx";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";

/**
 * The `/compute` and `/share` routes. Held behind the `ui.compute_share`
 * rollout flag so a restored tab or deep link does not reach a surface the
 * sidebar and command palette are hiding.
 */
export function ComputeSharePage({ mode }: { mode: ComputeShareMode }) {
	const enabled = useFeatureFlag(COMPUTE_SHARE_FLAG);
	if (enabled) {
		return <ComputeShareSurface mode={mode} />;
	}
	return (
		<div className="flex h-full min-h-0 items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyTitle>{mode === "compute" ? "Compute" : "Share"}</EmptyTitle>
					<EmptyDescription>
						This isn't available for your account yet.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</div>
	);
}
