import type { ChannelType } from "@ryu/blocks/desktop/channels.tsx";
import { create } from "zustand";

export interface ChannelSetupRequest {
	agentId: string;
	agentName: string;
	channelType: ChannelType;
}

interface ChannelSetupDialogState {
	open: boolean;
	openChannelSetup: (request: ChannelSetupRequest) => void;
	request: ChannelSetupRequest | null;
	setOpen: (open: boolean) => void;
}

/**
 * Lets agent creation hand the user directly into the existing channel setup
 * dialog. The channel dialog remains the single owner of credentials and
 * pairing; this store only carries the non-secret prefill across the global
 * sidebar mount.
 */
export const useChannelSetupDialog = create<ChannelSetupDialogState>((set) => ({
	request: null,
	open: false,
	openChannelSetup: (request) => set({ request, open: true }),
	setOpen: (open) =>
		set((state) => ({ open, request: open ? state.request : null })),
}));
