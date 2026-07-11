// useSidebarData - loads the sidebar's live-data sections for the active node and
// reloads on a node switch (url/token change). Failures per-source already
// degrade to empty inside loadSidebarData, so this never surfaces an error; the
// sidebar just shows empty sections offline.

import { useEffect, useRef, useState } from "react";
import { useCore } from "../core/CoreContext.tsx";
import { emptySidebarData, loadSidebarData, type SidebarData } from "./data.ts";

export function useSidebarData(): { data: SidebarData; loading: boolean } {
	const { target, url, token } = useCore();
	const [data, setData] = useState<SidebarData>(emptySidebarData);
	const [loading, setLoading] = useState(false);
	const reqRef = useRef(0);

	useEffect(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		loadSidebarData(target)
			.then((next) => {
				if (reqRef.current === reqId) {
					setData(next);
				}
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
		// url/token (primitives) drive a reload on node switch; target is derived.
	}, [target]);

	return { data, loading };
}
