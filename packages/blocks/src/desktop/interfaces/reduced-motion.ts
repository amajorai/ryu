import { useReducedMotion as useSystemReducedMotion } from "motion/react";
import { useContext } from "react";
import { HostReducedMotionContext } from "./game3d-settings.tsx";

// The interfaces' one reduced-motion hook. `motion/react`'s own hook reads only
// the system preference, so an interface that imported it kept animating after
// the user turned animations off in the host (Settings → Appearance → Motion).
// This one also honors that host setting, provided through
// `HostReducedMotionContext`, and returns a plain boolean.

/** Whether motion should be reduced: the system preference or the host's own "animations off". */
export function useReducedMotion(): boolean {
	const hostReduced = useContext(HostReducedMotionContext);
	return useSystemReducedMotion() === true || hostReduced;
}
