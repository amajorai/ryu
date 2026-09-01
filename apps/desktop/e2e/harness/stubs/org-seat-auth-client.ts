const members = [
	{
		id: "member-owner",
		role: "owner",
		user: { email: "owner@northstar.example", name: "Avery Chen" },
		userId: "user-owner",
	},
	{
		id: "member-2",
		role: "admin",
		user: { email: "ops@northstar.example", name: "Mina Patel" },
		userId: "user-2",
	},
	{
		id: "member-3",
		role: "member",
		user: { email: "design@northstar.example", name: "Noah Williams" },
		userId: "user-3",
	},
	{
		id: "member-4",
		role: "member",
		user: { email: "eng@northstar.example", name: "Sam Rivera" },
		userId: "user-4",
	},
] as const;

const invitations = [
	{
		email: "finance@northstar.example",
		id: "inv-finance",
		role: "member",
		status: "pending",
	},
] as const;

const ok = <T>(data: T) => ({ data, error: null });

export const authClient = {
	organization: {
		getActiveMember: async () => ok({ role: "owner", userId: "user-owner" }),
		inviteMember: async () => ok({}),
		listInvitations: async () => ok(invitations),
		listMembers: async () => ok({ members }),
		removeMember: async () => ok({}),
		updateMemberRole: async () => ok({}),
	},
};
