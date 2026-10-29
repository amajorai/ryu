// Whether a workspace interface is on screen. `previewLatched` turns true the
// first time one mounts and stays true for the session, so the conversation
// list keeps asking Core for message previews (one extra refetch per session,
// not two per interface mount and unmount).

import { create } from "zustand";

export interface InterfaceActiveState {
	active: boolean;
	/** True once any interface has been active in this session; never reset. */
	previewLatched: boolean;
	setActive: (active: boolean) => void;
}

export const useInterfaceActive = create<InterfaceActiveState>((set) => ({
	active: false,
	previewLatched: false,
	setActive: (active) =>
		set((state) => {
			const previewLatched = state.previewLatched || active;
			return state.active === active && state.previewLatched === previewLatched
				? state
				: { active, previewLatched };
		}),
}));
