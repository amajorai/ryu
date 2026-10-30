import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";

export type CurrentMemoryOwner = () => boolean;

export function useMemoryOwner(target: ApiTarget) {
	const ownerRef = useRef<{ target: ApiTarget } | null>(null);
	useLayoutEffect(() => {
		// Every committed lifetime is distinct, even after credentials return or
		// layout effects replay. Retired completions cannot adopt a later owner.
		const owner = { target };
		ownerRef.current = owner;
		return () => {
			if (ownerRef.current === owner) {
				ownerRef.current = null;
			}
		};
	}, [target]);
	return useCallback((): CurrentMemoryOwner | null => {
		const owner = ownerRef.current;
		if (!owner || owner.target !== target) {
			return null;
		}
		return () => ownerRef.current === owner;
	}, [target]);
}

/**
 * Run a preference write and surface a failure. The node is the only store for
 * these values, so a write that silently fails would leave the control showing a
 * setting the node never received — exactly the "settable value that cannot take
 * effect" this tab exists to avoid.
 */
export function persist(
	write: Promise<boolean>,
	isCurrent: CurrentMemoryOwner,
	what: string,
	onFailure?: () => void
): void {
	const failed = () => {
		if (!isCurrent()) {
			return;
		}
		onFailure?.();
		toast.error({
			title: `Couldn't save ${what}`,
			description: "Your change wasn't saved. Please try again.",
		});
	};
	write
		.then((ok) => {
			if (!ok) {
				failed();
			}
		})
		.catch(failed);
}
