"use client";

import { createContext, type ReactNode, useContext } from "react";

interface DataGridCellPresence {
	color: string;
	name: string;
}

const DataGridCellPresenceContext = createContext<Map<
	string,
	DataGridCellPresence
> | null>(null);

interface DataGridPresenceProviderProps {
	children: ReactNode;
	value: Map<string, DataGridCellPresence>;
}

function DataGridPresenceProvider({
	value,
	children,
}: DataGridPresenceProviderProps) {
	return (
		<DataGridCellPresenceContext.Provider value={value}>
			{children}
		</DataGridCellPresenceContext.Provider>
	);
}

function useDataGridPresence(cellKey: string): DataGridCellPresence | null {
	const map = useContext(DataGridCellPresenceContext);
	return map?.get(cellKey) ?? null;
}

export {
	type DataGridCellPresence,
	DataGridPresenceProvider,
	useDataGridPresence,
};
