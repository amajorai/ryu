/** Illustrative workspace content. Never a user result, execution request, or billing grant. */
export const WORKSPACE_PREVIEWS = [
	{
		id: "follow-ups",
		title: "Organize follow-ups",
		prompt: "Turn these meeting notes into next actions.",
		output:
			"Confirm the launch date · Maya\nReview the draft · Alex\nSchedule the next check-in · Sam",
	},
	{
		id: "project",
		title: "Plan a project",
		prompt: "Break a website launch into a workable plan.",
		output:
			"1. Draft the page and review the copy\n2. Check links and forms\n3. Publish the approved version",
	},
	{
		id: "review",
		title: "Review a change",
		prompt: "Help me review a code change before shipping.",
		output:
			"Check affected behavior\nReview permissions and error handling\nRun the relevant checks",
	},
] as const;
