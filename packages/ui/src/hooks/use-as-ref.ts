import { useIsomorphicLayoutEffect } from "@ryu/ui/hooks/use-isomorphic-layout-effect.ts";
import { useRef } from "react";

function useAsRef<T>(props: T) {
	const ref = useRef<T>(props);

	useIsomorphicLayoutEffect(() => {
		ref.current = props;
	});

	return ref;
}

export { useAsRef };
