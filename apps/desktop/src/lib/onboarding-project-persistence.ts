import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { ApiTarget } from "./api/client.ts";
import { fetchProjects, type ProjectRecord } from "./api/hierarchy.ts";
import { DESKTOP_ONBOARDING_PROJECT_KEY } from "./desktop-onboarding-state.ts";
import type { OnboardingProjectSeed } from "./onboarding-navigation.ts";

export class OnboardingProjectMissingError extends Error {
	constructor() {
		super(
			"Your saved onboarding project is no longer available. Create a project or skip this step."
		);
	}
}

export interface OnboardingProjectBinding {
	accountHash: string;
	nodeUrl: string;
}
interface ProjectPointer {
	binding: OnboardingProjectBinding;
	projectId: string;
	version: 1;
}

export async function bindOnboardingProjectTarget(
	target: ApiTarget,
	activeUserId: string | null
): Promise<OnboardingProjectBinding> {
	const url = new URL(target.url);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"The current node address cannot be used for project recovery."
		);
	}
	const identity = activeUserId
		? `account:${activeUserId}`
		: `local-owner:${target.token ?? ""}`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(identity)
	);
	const accountHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	return { nodeUrl: url.toString().replace(/\/+$/, ""), accountHash };
}

export function sameOnboardingProjectBinding(
	a: OnboardingProjectBinding,
	b: OnboardingProjectBinding
): boolean {
	return a.nodeUrl === b.nodeUrl && a.accountHash === b.accountHash;
}

export function clearOnboardingProjectPointer(): void {
	try {
		localStorage.removeItem(DESKTOP_ONBOARDING_PROJECT_KEY);
		if (localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY) !== null) {
			throw new Error("discarded removal");
		}
	} catch {
		throw new Error(
			"Ryu couldn't clear the saved onboarding project. Check device storage and retry."
		);
	}
}

function validIdentity(value: string | null | undefined): value is string {
	return isNativeText(value) && value.length > 0 && value.trim() === value;
}

export function persistAcknowledgedOnboardingProject(
	project: ProjectRecord,
	binding: OnboardingProjectBinding
): void {
	if (!validIdentity(project.id)) {
		throw new Error(
			"The node did not acknowledge a project identity. Retry continuation."
		);
	}
	if (
		project.coordinatorConversationId != null &&
		!validIdentity(project.coordinatorConversationId)
	) {
		throw new Error(
			"The node did not acknowledge a valid project main thread identity. Retry continuation."
		);
	}
	const pointer: ProjectPointer = {
		version: 1,
		projectId: project.id,
		binding,
	};
	const serialized = JSON.stringify(pointer);
	try {
		localStorage.setItem(DESKTOP_ONBOARDING_PROJECT_KEY, serialized);
		if (localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY) !== serialized) {
			throw new Error("discarded write");
		}
	} catch {
		throw new Error(
			"Your project was created, but Ryu couldn't save its setup handoff. Check device storage and retry continuation."
		);
	}
}

function readPointer(binding: OnboardingProjectBinding): ProjectPointer | null {
	const raw = localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY);
	if (raw === null) {
		return null;
	}
	const result = z
		.object({
			version: z.literal(1),
			projectId: z
				.string()
				.min(1)
				.refine((value) => value.trim() === value),
			binding: z.object({
				nodeUrl: z.literal(binding.nodeUrl),
				accountHash: z.literal(binding.accountHash),
			}),
		})
		.safeParse(
			(() => {
				try {
					return JSON.parse(raw);
				} catch {
					return null;
				}
			})()
		);
	if (!result.success) {
		clearOnboardingProjectPointer();
		return null;
	}
	const record = result.data;
	return { version: 1, projectId: record.projectId, binding };
}

/** Resolve identity against the real node; stored names and thread IDs are never authoritative. */
export async function restoreOnboardingProject(
	target: ApiTarget,
	binding: OnboardingProjectBinding
): Promise<OnboardingProjectSeed | null> {
	const pointer = readPointer(binding);
	if (!pointer) {
		return null;
	}
	const projects = await fetchProjects(target);
	const project = projects.find(
		(candidate) => candidate.id === pointer.projectId
	);
	if (!project) {
		clearOnboardingProjectPointer();
		throw new OnboardingProjectMissingError();
	}
	if (!validIdentity(project.coordinatorConversationId)) {
		throw new Error(
			"Ryu couldn't verify your onboarding project's main thread. It may have been deleted or become inaccessible. Retry or reset setup to skip its handoff."
		);
	}
	return {
		mainThreadId: project.coordinatorConversationId,
		name: project.name,
	};
}
