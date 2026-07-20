import { useSyncExternalStore } from "react";

const subscribe = () => () => {
	// No external subscription is needed; mount state changes only across hydration.
};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function useMounted() {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
