import { create } from "zustand";
export const useAuthState = create(() => ({
	// SAFETY: The authored alpha string is retained unchanged while widening this local state to its intended string-or-null domain.
	user: "alpha" as string | null,
	organization: "org",
}));
export const authClient = {
	useSession: () => {
		const { user } = useAuthState();
		return {
			data: user
				? { user: { id: user }, session: { id: `session-${user}` } }
				: null,
			isPending: false,
		};
	},
	useActiveOrganization: () => {
		const { organization } = useAuthState();
		return { data: { id: organization }, isPending: false };
	},
};
