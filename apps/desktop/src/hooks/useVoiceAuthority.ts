import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNodeStore, type Node } from "@/src/store/useNodeStore.ts";
import { useActiveNode, useActiveNodeGetter } from "./useActiveNode.ts";

const sameTarget = (a: Node, b: Node) =>
	a.url === b.url &&
	(a.token ?? null) === (b.token ?? null) &&
	(a.userJwt ?? null) === (b.userJwt ?? null);

export class VoiceRequestRetiredError extends Error {
	constructor() {
		super("This audio request belongs to a previous node or credential.");
		this.name = "VoiceRequestRetiredError";
	}
}

/** A request lifetime, including synchronous NodeStore A → B → A transitions. */
export function useVoiceAuthority(scope = "") {
	const node = useActiveNode();
	const getNode = useActiveNodeGetter();
	const currentGetter = useRef(getNode);
	const [revision, setRevision] = useState(0);
	const authority = useMemo(
		() => ({ node, retired: false, mounted: false }),
		[node.url, node.token, node.userJwt, getNode, scope, revision]
	);
	const current = useRef(authority);
	useLayoutEffect(() => {
		currentGetter.current = getNode;
		current.current = authority;
		authority.mounted = true;
		authority.retired = false;
		let observed = currentGetter.current();
		let override = localStorage.getItem("ryu_node_tab_override_enabled");
		const retire = () => {
			authority.retired = true;
			setRevision((n) => n + 1);
		};
		const check = () => {
			const next = currentGetter.current();
			if (!sameTarget(observed, next)) retire();
			observed = next;
		};
		const unsubscribe = useNodeStore.subscribe(check);
		// Override preferences can change without a NodeStore write. Retire even
		// if a same-turn toggle returns to its starting value before React renders.
		const onStorage = () => {
			const next = localStorage.getItem("ryu_node_tab_override_enabled");
			if (next !== override) retire();
			override = next;
		};
		window.addEventListener("storage", onStorage);
		check();
		return () => {
			authority.mounted = false;
			authority.retired = true;
			unsubscribe();
			window.removeEventListener("storage", onStorage);
		};
	}, [authority]);
	return {
		authority,
		isCurrent: () =>
			authority.mounted &&
			!authority.retired &&
			current.current === authority &&
			sameTarget(authority.node, currentGetter.current()),
	};
}
