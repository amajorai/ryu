import type { IslandApi } from "../shared/ipc.ts";

declare global {
	interface Window {
		island: IslandApi;
	}
}
