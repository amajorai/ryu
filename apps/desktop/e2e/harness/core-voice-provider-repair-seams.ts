const node = {
	id: "core-voice-provider-repair",
	name: "Local verification node",
	url: window.location.origin,
	token: null,
	userJwt: null,
	managed: false,
};
export function useActiveNode() {
	return node;
}
export function useActiveNodeGetter() {
	return () => node;
}
