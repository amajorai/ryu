import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import { useEffect } from "react";
import {
	usePluginContributions,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";
import { useInterfaceStore } from "./interface-store.ts";
import { provisionalInterfaces } from "./registry.ts";

const EMPTY: InterfaceDescriptor[] = [];

/**
 * Marketplace interfaces from enabled plugins. The rows are validated once at
 * the API boundary (`getPluginContributions`), so this is a plain read.
 */
export function useContributedInterfaces(): InterfaceDescriptor[] {
	// Older Core builds (and test doubles) omit the family entirely.
	return usePluginContributions().interfaces ?? EMPTY;
}

/**
 * Mirror the contributed list into the interface store so switchers and the
 * window title can resolve Marketplace interfaces without their own query.
 * Call once from an always-mounted shell component (LayoutContent).
 *
 * The returned list is what the shell resolves the active interface against:
 * while the first fetch is pending it may hold a pending placeholder for the
 * remembered interface (see {@link provisionalInterfaces}). The store mirror
 * only ever receives real rows.
 */
export function useSyncContributedInterfaces(): InterfaceDescriptor[] {
	const contributed = useContributedInterfaces();
	// Tracked props only: this re-renders when `data` or `isPending` changes,
	// including a failed first fetch that settles without data.
	const { data, isPending } = usePluginContributionsQuery();
	const workspaceInterfaceId = useInterfaceStore(
		(state) => state.workspaceInterfaceId
	);
	useEffect(() => {
		useInterfaceStore.getState().setContributed(contributed);
	}, [contributed]);
	const pending = data === undefined && isPending;
	return pending
		? provisionalInterfaces(true, workspaceInterfaceId)
		: contributed;
}
