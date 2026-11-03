// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
// The shipping ResourcePermissions editor mounted against the peer, and the DOM
// helpers the ResourcePermissions.authority suites drive it with.
import { expect } from "bun:test";
import { act, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import { server } from "./ResourcePermissions.authority.native-http-peer.test-support.tsx";
import {
	bodyReads,
	type Call,
	calls,
	credentials,
	drain,
	type EditedResource,
	type HeldBody,
	live,
	type Overwrite,
	type Owner,
	resourceId,
	resourcePath,
	runtimeErrors,
} from "./ResourcePermissions.authority.native-http-store.test-support.tsx";

export const { createRoot } = await import("react-dom/client");
export const { I18nProvider } = await import("@ryu/i18n/react");
export const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
export const { sileo } = await import("sileo");
export const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
export const { request } = await import("@/src/lib/api/client.ts");
export const { gatewayJsonValueSchema } = await import(
	"@/src/lib/api/gateway-json-contracts.ts"
);
export const { BACKEND_URL, TOKEN_KEY, vaultHydrated } = await import(
	"@/lib/auth-client.ts"
);
export const { ResourcePermissions } = await import(
	"./ResourcePermissions.tsx"
);
await vaultHydrated;
export const previousNodes = useNodeStore.getState();
export const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
export const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

export function node(
	owner: Owner,
	variant: "a" | "bearer" | "jwt" = "a"
): Node {
	return {
		name: `permissions-${owner}`,
		url: `${server.url.origin}/${owner}`,
		...credentials(owner, variant),
	};
}
export function target(
	owner: Owner,
	variant: "a" | "bearer" | "jwt" = "a"
): ApiTarget {
	const current = node(owner, variant);
	return { url: current.url, token: current.token, userJwt: current.userJwt };
}
export async function selectNode(current: Node) {
	await act(async () =>
		useNodeStore.setState({
			nodes: [current],
			localNodes: [current],
			cloudNodes: [],
			defaultNode: current.name,
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		})
	);
}
// The mounted host owns which resource the real editor receives, exactly as a
// settings page switching between agents or spaces passes new props.
export function Surface() {
	const [draft, setDraft] = useState("Unsent permissions draft");
	const [resource, setResource] = useState<EditedResource>({
		kind: "agent",
		id: resourceId,
	});
	useEffect(() => {
		live.selectResource = setResource;
		return () => {
			live.selectResource = null;
		};
	}, []);
	return (
		<>
			<input
				aria-label="Unsent permissions draft"
				onChange={(event) => setDraft(event.target.value)}
				value={draft}
			/>
			<div data-permissions-editor="">
				<ResourcePermissions
					resourceId={resource.id}
					resourceKind={resource.kind}
					resourceName="Authority receipt"
				/>
			</div>
			<Toaster theme="light" />
		</>
	);
}
export function tree() {
	return (
		<I18nProvider>
			<Surface />
		</I18nProvider>
	);
}
export async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
export function editor() {
	const current = live.container?.querySelector<HTMLElement>(
		"[data-permissions-editor]"
	);
	if (!current) {
		throw new Error("Missing real permission editor");
	}
	return current;
}
export function button(name: string, within: ParentNode = editor()) {
	const current = [
		...within.querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === name);
	if (!current) {
		throw new Error(`Missing real permission action ${name}`);
	}
	return current;
}
export function draftInput() {
	const current = live.container?.querySelector<HTMLInputElement>(
		'[aria-label="Unsent permissions draft"]'
	);
	if (!current) {
		throw new Error("Missing retained draft consumer");
	}
	return current;
}
export function permissionElement(
	index: number,
	name: "View items" | "Edit items"
) {
	const card = editor().querySelectorAll("li")[index];
	if (!card) {
		throw new Error(`Missing actual overwrite card ${index}`);
	}
	const label = [...card.querySelectorAll("p")].find(
		(item) => item.textContent?.trim() === name
	);
	const row = label?.parentElement?.parentElement;
	if (!row) {
		throw new Error(`Missing actual permission row ${name}`);
	}
	return row;
}
export function editPermission(
	name: "View items" | "Edit items",
	setting: "Allow" | "Deny" | "Inherit"
) {
	return act(async () => button(setting, permissionElement(0, name)).click());
}
export function assertRenderedRows(rows: Overwrite[]) {
	const cards = [...editor().querySelectorAll("li")];
	expect(cards).toHaveLength(rows.length);
	for (const [index, row] of rows.entries()) {
		const expectedLabel =
			row.target_id === "role-current"
				? "Current role"
				: row.target_id === "team-retained"
					? "Retained team"
					: "Source role";
		expect(cards[index]?.textContent).toContain(expectedLabel);
		for (const [permission, label] of [
			["space.view", "View items"],
			["space.edit", "Edit items"],
		] as const) {
			const expected = row.deny.includes(permission)
				? "Deny"
				: row.allow.includes(permission)
					? "Allow"
					: "Inherit";
			// The shipping tri-state control exposes selection through its real
			// default Button appearance. No fixture-created selection attribute.
			const actual = permissionElement(index, label);
			for (const setting of ["Deny", "Inherit", "Allow"] as const) {
				expect(button(setting, actual).classList.contains("bg-primary")).toBe(
					setting === expected
				);
			}
		}
	}
}
export function acknowledged(call: Call) {
	return bodyReads.find((read) => read.id === call.id);
}
export function publishedReply(call: Call): string {
	if (typeof call.reply !== "string") {
		throw new Error(
			`Actual native request ${call.id} has no published response bytes`
		);
	}
	return call.reply;
}
export async function mount() {
	expect(BACKEND_URL).toBe(server.url.origin);
	live.container = document.createElement("div");
	document.body.append(live.container);
	live.root = createRoot(live.container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () => live.root!.render(tree()));
}
export async function completeRead(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	after: number,
	label: string
) {
	const credential = credentials(owner, variant);
	await until(
		() =>
			["/api/acl/vocabulary", "/api/acl/principals", resourcePath].every(
				(path) =>
					calls.some(
						(call) =>
							call.id > after &&
							call.owner === owner &&
							call.method === "GET" &&
							call.url === `${node(owner).url}${path}` &&
							call.bearer === `Bearer ${credential.token}` &&
							call.delegation === credential.userJwt &&
							acknowledged(call)?.status === 200
					)
			),
		"Actual editor did not consume all three captured-authority read bodies"
	);
	await until(
		() =>
			editor().textContent?.includes(label) === true &&
			!editor().textContent?.includes("Loading permissions"),
		"Actual editor did not render its acknowledged target rows"
	);
}
export async function releaseAndConsume(held: HeldBody) {
	await act(async () => {
		held.release();
		await drain();
	});
	expect(held.released).toBe(true);
	expect(held.cancelled).toBeNull();
	const call = calls.find((item) => item.id === held.id)!;
	expect(acknowledged(call)).toEqual({
		id: call.id,
		status: call.status,
		text: publishedReply(call),
	});
	await act(async () => {
		await drain();
	});
}
export async function externalWrite(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	rows: Overwrite[]
) {
	const start = live.nextId;
	await act(async () => {
		expect(
			await request(
				target(owner, variant),
				resourcePath,
				{
					method: "PUT",
					body: { overwrites: rows },
				},
				gatewayJsonValueSchema
			)
		).toEqual({ ok: true });
	});
	const write = calls.find(
		(call) => call.id > start && call.owner === owner && call.method === "PUT"
	)!;
	const credential = credentials(owner, variant);
	expect(write).toMatchObject({
		owner,
		method: "PUT",
		url: `${node(owner).url}${resourcePath}`,
		bearer: `Bearer ${credential.token}`,
		delegation: credential.userJwt,
		body: { overwrites: rows },
		status: 200,
	});
	expect(acknowledged(write)).toEqual({
		id: write.id,
		status: 200,
		text: JSON.stringify({ ok: true }),
	});
	return write;
}
