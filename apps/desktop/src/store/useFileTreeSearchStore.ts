import { create } from "zustand";

export interface FileTreeSearchRequest {
	nonce: number;
	query: string;
}

interface FileTreeSearchState {
	clearIfOwner: (owner: string) => void;
	owner: string | null;
	publish: (owner: string, request: FileTreeSearchRequest | null) => void;
	request: FileTreeSearchRequest | null;
}

const EMPTY: Pick<FileTreeSearchState, "owner" | "request"> = {
	owner: null,
	request: null,
};

/** The focused chat's request for the shared/project-hosted Files tree. */
export const useFileTreeSearchStore = create<FileTreeSearchState>((set) => ({
	...EMPTY,
	clearIfOwner: (owner) =>
		set((state) => (state.owner === owner ? EMPTY : state)),
	publish: (owner, request) => set({ owner, request }),
}));
