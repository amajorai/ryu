import { expect, test } from "bun:test";
import { parseCloudGithubConnection } from "./cloud-github.ts";

test("GitHub connection projects only verified public metadata", () => {
	expect(
		parseCloudGithubConnection({
			connected: true,
			login: "fixture-owner",
			vaultKey: "GITHUB_TOKEN",
			repositories: [{ fullName: "fixture-owner/project", private: true }],
			token: "must-never-be-retained",
		})
	).toEqual({
		connected: true,
		login: "fixture-owner",
		vaultKey: "GITHUB_TOKEN",
		repositories: [{ fullName: "fixture-owner/project", private: true }],
	});
});
test("GitHub connection rejects malformed metadata before rendering", () => {
	expect(() =>
		parseCloudGithubConnection({
			connected: true,
			login: null,
			vaultKey: null,
			repositories: [],
		})
	).toThrow();
	expect(() =>
		parseCloudGithubConnection({
			connected: false,
			login: null,
			vaultKey: null,
			repositories: [{ fullName: "https://evil.example/repo", private: true }],
		})
	).toThrow();
});
