// useSidebarData - loads the sidebar's live-data sections for the active node and
// reloads on a node switch (url/token change). Failures per-source already
// degrade to empty inside loadSidebarData, so this never surfaces an error; the
// sidebar just shows empty sections offline.

import { useEffect, useRef, useState } from "react";
import { useCore } from "../core/CoreContext.tsx";
import { emptySidebarData, loadSidebarData, type SidebarData } from "./data.ts";

export interface SidebarDataState {
	data: SidebarData;
	loading: boolean;
}

export function useSidebarData(): SidebarDataState {
	const { target } = useCore();
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
		// The memoized target changes when the active node changes.
	}, [target]);

	return { data, loading };
}
