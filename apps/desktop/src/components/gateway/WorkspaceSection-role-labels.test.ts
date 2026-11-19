import { describe, expect, test } from "bun:test";
import {
	workspaceRoleLabel,
	workspaceRoleSentence,
} from "./WorkspaceSection-role-labels.ts";

// Records the sources it is asked for, so a test sees which catalog rows a
// role reads; an untranslated source comes back unchanged.
function recorder(translations: Record<string, string> = {}) {
	const asked: string[] = [];
	const tl = (source: string) => {
		asked.push(source);
		return translations[source] ?? source;
	};
	return { asked, tl };
}

describe("workspace role copy", () => {
	test("each role reads as a title-case label, never the raw enum", () => {
		const { tl } = recorder();
		expect(workspaceRoleLabel(tl, "owner")).toBe("Owner");
		expect(workspaceRoleLabel(tl, "admin")).toBe("Administrator");
		expect(workspaceRoleLabel(tl, "viewer")).toBe("Viewer");
		expect(workspaceRoleLabel(tl, "member")).toBe("Member");
		expect(workspaceRoleLabel(tl, null)).toBe("Member");
	});

	test("an administrator never reads the Admin area row", () => {
		const { asked, tl } = recorder({ Admin: "管理", Administrator: "管理者" });
		expect(workspaceRoleLabel(tl, "admin")).toBe("管理者");
		expect(asked).not.toContain("Admin");
	});

	test("each role has its own whole sentence", () => {
		const { asked, tl } = recorder({
			"You are an owner of this workspace.":
				"あなたはこのワークスペースのオーナーです。",
		});
		expect(workspaceRoleSentence(tl, "owner")).toBe(
			"あなたはこのワークスペースのオーナーです。"
		);
		expect(workspaceRoleSentence(tl, "admin")).toBe(
			"You are an administrator of this workspace."
		);
		expect(workspaceRoleSentence(tl, null)).toBe(
			"You are a member of this workspace."
		);
		expect(asked.every((source) => !source.includes("{role}"))).toBe(true);
	});
});
