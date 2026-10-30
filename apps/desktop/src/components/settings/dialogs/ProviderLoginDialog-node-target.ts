// Node credential refs for the provider login dialog's flow effect.

import { useEffect, useRef } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";

export function useProviderLoginNodeTarget() {
	const activeNode = useActiveNode();
	// The flow-owning effect below reads the node's CREDENTIAL through a ref and
	// depends only on its URL. Depending on the token — as an object OR as a
	// string — cannot work here, and depending on the string was the mistake this
	// comment used to defend.
	//
	// `useNodeStore` refreshes cloud tokens on every window `focus`, and
	// `refreshCloudTokens` -> `fetchManagedNodes()` asks the control plane to mint
	// a node-bound delegation per call. Its `iat`/`exp` changes every time, so
	// each fetch yields a different token STRING, which
	// `decorateLocal` then writes into the active node. This flow deliberately
	// sends the user to the system browser, so a focus round-trip is guaranteed:
	// for anyone on a managed node, coming back from the consent screen changed
	// the token, re-ran the effect, and its cleanup killed the OAuth child the
	// user had just authorized — the exact abort, on the exact path, that the
	// object dependency caused.
	//
	// The URL is what identifies the target and it does not churn on refresh, so
	// it stays a real dependency: pointing the dialog at a different node SHOULD
	// restart the flow. The token is only ever needed at call time, and a ref
	// hands each call the freshest one — which matters, because the credential
	// the cleanup cancels with must not be the expired one from 15 minutes ago.
	const nodeUrl = activeNode.url;
	const nodeToken = activeNode.token ?? null;
	const nodeUserJwt = activeNode.userJwt ?? null;
	const tokenRef = useRef(nodeToken);
	const userJwtRef = useRef(nodeUserJwt);
	// Declared BEFORE the flow effect so React runs it first in every commit,
	// leaving the ref current by the time `run()` reads it.
	useEffect(() => {
		tokenRef.current = nodeToken;
		userJwtRef.current = nodeUserJwt;
	}, [nodeToken, nodeUserJwt]);
	return { activeNode, nodeUrl, tokenRef, userJwtRef };
}
