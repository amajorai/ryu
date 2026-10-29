import { type ApiTarget, toTarget } from "../../../src/lib/api/client.ts";

// Stable like the real hooks: the Store's node-fenced readers memoize request
// lifetimes on this identity, so a fresh node or getter per render would retire
// and restart every catalog read in a loop.
const fixtureNode = {
	name: "Local Marketplace fixture",
	token: "fixture-node-token",
	url: window.location.origin,
	userJwt: null,
};
// The real `useActiveTarget` memoizes `toTarget(node)` per credential; the
// fixture's credential never changes, so one narrowed target is equally stable.
const fixtureTarget = toTarget(fixtureNode);

function getFixtureNode() {
	return fixtureNode;
}

function getFixtureTarget(): ApiTarget {
	return fixtureTarget;
}

export function useActiveNode() {
	return fixtureNode;
}

export function useActiveNodeGetter() {
	return getFixtureNode;
}

export function useActiveTarget(): ApiTarget {
	return fixtureTarget;
}

export function useActiveTargetGetter(): () => ApiTarget {
	return getFixtureTarget;
}
