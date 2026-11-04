import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareConversationPeopleSection } from "./ShareConversationDialog-people-section.tsx";

// The closed "Add a person" select shows the picked person's name. A bare
// <SelectValue /> without `items` printed their user id.

const member = { email: "ada@example.com", id: "user_7f3a", name: "Ada" };
const noop = () => undefined;

describe("ShareConversationPeopleSection add-person trigger", () => {
	test("shows the selected member's name, not the user id", () => {
		const html = renderToStaticMarkup(
			<ShareConversationPeopleSection
				access={{
					can_manage: true,
					collaborators: [],
					owner_user_id: null,
					team_id: null,
					visibility: "private",
				}}
				addPerson={noop}
				availableMembers={[member]}
				canManage
				memberById={new Map([[member.id, member]])}
				owner={null}
				ownerEmail=""
				ownerIsCurrentUser={false}
				ownerName=""
				ownerUserId={null}
				personToAdd={member.id}
				removePerson={noop}
				updateRole={noop}
			/>
		);
		const start = html.indexOf('data-slot="select-trigger"');
		const trigger = html.slice(start, html.indexOf("</button>", start));
		expect(trigger).toContain("Ada");
		expect(trigger).not.toContain("user_7f3a");
	});
});
