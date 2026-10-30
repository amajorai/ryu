import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";

interface GlobalWriteResource {
	pending: number | null;
	target: ApiTarget;
	version: number;
}

export interface GlobalWriteScope {
	id: number;
	resource: GlobalWriteResource;
	target: ApiTarget;
}

/** Serializes global shortcut preference writes for the active node's target. */
export function useGlobalWriteScope(globalTarget: ApiTarget) {
	const globalScopeSequence = useRef(0);
	const globalResources = useRef<
		Array<{ target: ApiTarget; pending: number | null; version: number }>
	>([]);
	const globalScope = useMemo(() => {
		// Keep the shared complete-JSON write resource across A→B→A, but give
		// each mounted UI scope a new opaque id; credentials never enter keys.
		let resource = globalResources.current.find(
			({ target }) =>
				target.url === globalTarget.url &&
				target.token === globalTarget.token &&
				(target.userJwt ?? null) === (globalTarget.userJwt ?? null)
		);
		if (!resource) {
			resource = { target: globalTarget, pending: null, version: 0 };
			globalResources.current.push(resource);
		}
		return {
			id: ++globalScopeSequence.current,
			target: globalTarget,
			resource,
		};
	}, [globalTarget.url, globalTarget.token, globalTarget.userJwt]);
	const globalAlive = useRef(false);
	useEffect(() => {
		globalAlive.current = true;
		return () => {
			globalAlive.current = false;
		};
	}, []);
	const [, refreshGlobalControls] = useState(0);
	const beginGlobalWrite = () => {
		if (!globalAlive.current || globalScope.resource.pending !== null) {
			return false;
		}
		globalScope.resource.pending = globalScope.id;
		refreshGlobalControls((version) => version + 1);
		return true;
	};
	const endGlobalWrite = () => {
		if (globalScope.resource.pending !== globalScope.id) {
			return;
		}
		globalScope.resource.pending = null;
		globalScope.resource.version += 1;
		if (globalAlive.current) {
			refreshGlobalControls((version) => version + 1);
		}
	};
	return { beginGlobalWrite, endGlobalWrite, globalScope };
}
