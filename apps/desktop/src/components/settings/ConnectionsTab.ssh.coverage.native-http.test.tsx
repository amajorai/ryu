import { expect, test } from "bun:test";
import {
	button,
	click,
	dialogTitled,
	harness,
	ipc,
	mount,
	nodeCalls,
	openSshAdd,
	openTab,
	registerConnectionsCoverageHooks,
	rowCaption,
	SSH_CONNECTIONS_STORAGE_KEY,
	saveSsh,
	settingsRow,
	settle,
	sshAlert,
	sshDialog,
	sshFields,
	storedProfiles,
	text,
	typeInto,
	unmount,
} from "./ConnectionsTab.coverage.test-support.tsx";

// Control-level coverage for the shipping ConnectionsTab's SSH profiles, which
// persist in localStorage and never reach the node or the native bridge. The
// harness is shared with ConnectionsTab.coverage.native-http.test.tsx.
registerConnectionsCoverageHooks();

test("SSH fields validate host, port and identity file before anything is stored", async () => {
	await mount();
	await openTab("SSH", "SSH connections from this device");
	await openSshAdd();
	let fields = sshFields();
	expect(fields.port.value).toBe("22");
	expect(fields.username.value).toBe("");
	expect(fields.identity()).toBeNull();

	await saveSsh();
	expect(sshAlert()).toBe(
		"Enter a display name, valid host, and port from 1 to 65535"
	);
	await typeInto(fields.name, "Release builder");
	// A typed username isolates each check below to the field under test.
	await typeInto(fields.username, "builder");
	await typeInto(fields.host, "build host.example.test");
	await saveSsh();
	expect(sshAlert()).toBe(
		"Enter a display name, valid host, and port from 1 to 65535"
	);
	await typeInto(fields.host, "build.example.test");
	for (const port of ["0", "65536", "22a", "2.5", ""]) {
		await typeInto(fields.port, port);
		await saveSsh();
		expect(sshAlert()).toBe(
			"Enter a display name, valid host, and port from 1 to 65535"
		);
	}
	await typeInto(fields.port, "2222");
	await click(button("Identity file", fields.dialog));
	expect(
		button("Identity file", fields.dialog).getAttribute("aria-pressed")
	).toBe("true");
	expect(fields.identity()).not.toBeNull();
	await saveSsh();
	expect(sshAlert()).toBe("Choose an identity file path");
	expect(storedProfiles()).toEqual([]);
	expect(settingsRow("Release builder", harness.container)).toBeNull();

	fields = sshFields();
	const identity = fields.identity();
	if (!identity) {
		throw new Error("Missing identity file input");
	}
	await typeInto(identity, "  ~/.ssh/id_ed25519  ");
	await saveSsh();
	await settle(() => sshDialog() === null, "SSH dialog closed", text);
	const [saved] = storedProfiles();
	expect(saved).toMatchObject({
		auth: "identity",
		host: "build.example.test",
		identityFile: "~/.ssh/id_ed25519",
		name: "Release builder",
		port: 2222,
		username: "builder",
	});
	expect(rowCaption("Release builder", harness.container)).toBe(
		"builder@build.example.test:2222·~/.ssh/id_ed25519"
	);
	expect(text()).toContain("SSH connection saved");
	// Ryu stores only the path: no native command or request touches the key.
	expect(ipc.some((call) => JSON.stringify(call).includes("id_ed25519"))).toBe(
		false
	);
	expect(nodeCalls.some((route) => route.includes("ssh"))).toBe(false);
});

test("SSH username comes from user@host unless typed, edits keep the id and other profiles, and a remount reads them back", async () => {
	await mount();
	await openTab("SSH", "SSH connections from this device");

	await openSshAdd();
	let fields = sshFields();
	await typeInto(fields.name, "Deploy box");
	await typeInto(fields.host, "deploy@build.example.test");
	await saveSsh();
	await settle(() => sshDialog() === null, "first profile saved", text);

	await openSshAdd();
	fields = sshFields();
	await typeInto(fields.name, "Dev host");
	await typeInto(fields.host, "dev.example.test");
	await typeInto(fields.username, "runner");
	await typeInto(fields.port, "2200");
	await saveSsh();
	await settle(() => sshDialog() === null, "second profile saved", text);

	const [deploy, dev] = storedProfiles();
	expect(deploy).toMatchObject({
		auth: "none",
		host: "build.example.test",
		name: "Deploy box",
		port: 22,
		username: "deploy",
	});
	expect(deploy).not.toHaveProperty("identityFile");
	expect(dev).toMatchObject({
		auth: "none",
		host: "dev.example.test",
		name: "Dev host",
		port: 2200,
		username: "runner",
	});
	expect(rowCaption("Deploy box", harness.container)).toBe(
		"deploy@build.example.test:22·Default SSH auth"
	);

	// Edit the first profile: the dialog is prefilled, and the save keeps its id.
	const deployRow = settingsRow("Deploy box", harness.container);
	if (!deployRow) {
		throw new Error("Missing Deploy box row");
	}
	await click(button("Edit", deployRow));
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog",
		text
	);
	fields = sshFields();
	expect(fields.name.value).toBe("Deploy box");
	expect(fields.host.value).toBe("build.example.test");
	expect(fields.username.value).toBe("deploy");
	expect(fields.port.value).toBe("22");
	await typeInto(fields.name, "Deploy host");
	await typeInto(fields.port, "2022");
	await saveSsh();
	await settle(() => sshDialog() === null, "edit saved", text);
	expect(text()).toContain("SSH connection updated");
	const [edited, conserved] = storedProfiles();
	expect(edited).toMatchObject({
		id: deploy?.id,
		name: "Deploy host",
		port: 2022,
		username: "deploy",
	});
	expect(conserved).toEqual(dev);

	// Remove only the edited profile; the other one survives a remount.
	await click(button("Remove Deploy host", harness.container));
	await settle(
		() => settingsRow("Deploy host", harness.container) === null,
		"profile removed",
		text
	);
	expect(storedProfiles()).toEqual([dev]);
	await unmount();
	await mount();
	await openTab("SSH", "SSH connections from this device");
	expect(rowCaption("Dev host", harness.container)).toBe(
		"runner@dev.example.test:2200·Default SSH auth"
	);
	expect(settingsRow("Deploy host", harness.container)).toBeNull();
});

test("a blank optional Username saves a plain-host profile, clearing a username keeps the profile, and both survive a remount", async () => {
	await mount();
	await openTab("SSH", "SSH connections from this device");

	await openSshAdd();
	let fields = sshFields();
	await typeInto(fields.name, "Plain host");
	await typeInto(fields.host, "  plain.example.test  ");
	expect(fields.username.value).toBe("");
	await saveSsh();
	await settle(
		() => sshDialog() === null,
		`plain-host profile saved (alert: ${sshAlert() || "none"})`,
		text
	);
	expect(text()).toContain("SSH connection saved");

	await openSshAdd();
	fields = sshFields();
	await typeInto(fields.name, "Ops host");
	await typeInto(fields.host, "ops.example.test");
	await typeInto(fields.username, "ops");
	await saveSsh();
	await settle(() => sshDialog() === null, "ops profile saved", text);

	const [plain, ops] = storedProfiles();
	expect(plain).toEqual({
		auth: "none",
		host: "plain.example.test",
		id: expect.any(String),
		name: "Plain host",
		port: 22,
		username: "",
	});
	expect(ops).toMatchObject({ host: "ops.example.test", username: "ops" });
	expect(rowCaption("Plain host", harness.container)).toBe(
		"plain.example.test:22·Default SSH auth"
	);

	// Clearing the optional Username (whitespace only) keeps the same profile.
	const opsRow = settingsRow("Ops host", harness.container);
	if (!opsRow) {
		throw new Error("Missing Ops host row");
	}
	await click(button("Edit", opsRow));
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog",
		text
	);
	fields = sshFields();
	expect(fields.username.value).toBe("ops");
	await typeInto(fields.username, "   ");
	await saveSsh();
	await settle(
		() => sshDialog() === null,
		`cleared username saved (alert: ${sshAlert() || "none"})`,
		text
	);
	expect(text()).toContain("SSH connection updated");
	expect(storedProfiles()).toEqual([plain, { ...ops, username: "" }]);
	expect(rowCaption("Ops host", harness.container)).toBe(
		"ops.example.test:22·Default SSH auth"
	);

	// A remount rebuilds both username-less profiles from storage, and an
	// unchanged edit of one of them saves under the same id.
	await unmount();
	await mount();
	await openTab("SSH", "SSH connections from this device");
	expect(rowCaption("Plain host", harness.container)).toBe(
		"plain.example.test:22·Default SSH auth"
	);
	expect(rowCaption("Ops host", harness.container)).toBe(
		"ops.example.test:22·Default SSH auth"
	);
	await click(
		button(
			"Edit",
			settingsRow("Plain host", harness.container) ?? harness.container
		)
	);
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog after remount",
		text
	);
	fields = sshFields();
	expect(fields.host.value).toBe("plain.example.test");
	expect(fields.username.value).toBe("");
	await saveSsh();
	await settle(
		() => sshDialog() === null,
		`unchanged edit saved (alert: ${sshAlert() || "none"})`,
		text
	);
	expect(storedProfiles()).toEqual([plain, { ...ops, username: "" }]);
});

test("switching an identity-file profile back to No auth drops the stored identity path", async () => {
	localStorage.setItem(
		SSH_CONNECTIONS_STORAGE_KEY,
		JSON.stringify([
			{
				auth: "identity",
				host: "keys.example.test",
				id: "ssh-keys-profile",
				identityFile: "~/.ssh/id_ed25519",
				name: "Key host",
				port: 22,
				username: "ops",
			},
		])
	);
	await mount();
	await openTab("SSH", "SSH connections from this device");
	const row = settingsRow("Key host", harness.container);
	expect(rowCaption("Key host", harness.container)).toBe(
		"ops@keys.example.test:22·~/.ssh/id_ed25519"
	);
	await click(button("Edit", row ?? harness.container));
	await settle(
		() => dialogTitled("Edit SSH connection") !== null,
		"edit dialog",
		text
	);
	const fields = sshFields();
	expect(fields.identity()?.value).toBe("~/.ssh/id_ed25519");
	await click(button("No auth", fields.dialog));
	expect(fields.identity()).toBeNull();
	await saveSsh();
	await settle(() => sshDialog() === null, "edit saved", text);
	expect(storedProfiles()).toEqual([
		{
			auth: "none",
			host: "keys.example.test",
			id: "ssh-keys-profile",
			name: "Key host",
			port: 22,
			username: "ops",
		},
	]);
	expect(rowCaption("Key host", harness.container)).toBe(
		"ops@keys.example.test:22·Default SSH auth"
	);
});
