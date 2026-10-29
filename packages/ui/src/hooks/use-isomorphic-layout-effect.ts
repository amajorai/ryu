import { useEffect, useLayoutEffect } from "react";

const useIsomorphicLayoutEffect =
	globalThis.window === undefined ? useEffect : useLayoutEffect;

export { useIsomorphicLayoutEffect };
