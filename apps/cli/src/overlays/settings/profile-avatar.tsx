/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "@ryuhq/core-client/client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	securityMessageSuccessResponseSchema,
	securitySessionResponseSchema,
} from "./account-security-response-contracts.ts";

export function ProfileAvatar({
	active,
	authTarget,
	onEditingChange,
}: {
	active: boolean;
	authTarget: ApiTarget;
	onEditingChange: (editing: boolean) => void;
}) {
	const theme = useTheme();
	const controllerRef = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			controllerRef.current?.abort();
		},
		[authTarget.url, authTarget.token]
	);
	const [stage, setStage] = useState<"idle" | "upload" | "remove">("idle");
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const changeStage = (next: typeof stage) => {
		setStage(next);
		onEditingChange(next !== "idle");
		setMessage("");
		setPath("");
	};
	const submit = async () => {
		if (busy || stage === "idle") {
			return;
		}
		const controller = new AbortController();
		controllerRef.current?.abort();
		controllerRef.current = controller;
		const signal = controller.signal;
		setBusy(true);
		setMessage("");
		try {
			if (stage === "upload") {
				const file = Bun.file(path.trim());
				if (!(await file.exists())) {
					throw new Error("The image file does not exist.");
				}
				if (file.size > 5 * 1024 * 1024) {
					throw new Error("Choose an image smaller than 5 MB.");
				}
				if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
					throw new Error("Choose a JPEG, PNG, or WebP image.");
				}
				const form = new FormData();
				form.append(
					"avatar",
					new File(
						[await file.arrayBuffer()],
						path.trim().split("/").at(-1) ?? "avatar",
						{ type: file.type }
					)
				);
				const headers = new Headers(
					makeHeaders(authTarget.token, authTarget.userJwt)
				);
				headers.delete("Content-Type");
				const response = await fetchForTarget(authTarget)(
					apiUrl(authTarget, "/api/profile/avatar"),
					{ method: "POST", headers, body: form, signal }
				);
				if (!response.ok) {
					throw new Error(`Upload rejected (${response.status}).`);
				}
				const result = avatarUploadConfirmationSchema.parse(
					await response.json()
				);
				if (result.success !== true || !result.avatarId) {
					throw new Error("Upload was not confirmed.");
				}
				const session = await request(
					authTarget,
					"/api/auth/get-session",
					{ signal },
					securitySessionResponseSchema
				);
				if (session?.user?.avatarId !== result.avatarId) {
					throw new Error("Profile photo did not match readback.");
				}
			} else {
				const result = await request(
					authTarget,
					"/api/profile/avatar",
					{ method: "DELETE", signal },
					securityMessageSuccessResponseSchema
				);
				if (result.success !== true) {
					throw new Error("Removal was not confirmed.");
				}
				const session = await request(
					authTarget,
					"/api/auth/get-session",
					{ signal },
					securitySessionResponseSchema
				);
				if (!session?.user || session.user.avatarId !== null) {
					throw new Error("Profile photo remains set after removal.");
				}
			}
			if (signal.aborted) {
				return;
			}
			changeStage("idle");
			setMessage("Profile photo saved and confirmed.");
		} catch (error) {
			if (signal.aborted) {
				return;
			}
			setMessage(
				`Could not update profile photo: ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			if (!signal.aborted) {
				setBusy(false);
			}
		}
	};
	useKeyboard((key) => {
		if (!active || busy) {
			return;
		}
		if (stage !== "idle") {
			if (key.name === "tab" || (stage === "remove" && key.name === "n")) {
				changeStage("idle");
			} else if (
				key.name === "return" ||
				(stage === "remove" && key.name === "y")
			) {
				void submit();
			}
			return;
		}
		if (key.name === "a") {
			changeStage("upload");
		} else if (key.name === "d") {
			changeStage("remove");
		}
	});
	return (
		<box flexDirection="column" gap={1}>
			<text fg={theme.colors.mutedForeground}>
				Profile photo · a upload local image · d remove
			</text>
			{stage === "upload" ? (
				<>
					<text>JPEG, PNG, or WebP · maximum 5 MB</text>
					<input
						focused={active}
						onInput={setPath}
						placeholder="Absolute path to image"
						value={path}
					/>
					<text>Enter upload · Tab cancel</text>
				</>
			) : null}
			{stage === "remove" ? (
				<text>Remove your profile photo? y confirm · n cancel</text>
			) : null}
			{busy ? <text>Updating photo…</text> : null}
			{message ? (
				<text
					fg={
						message.startsWith("Could not")
							? theme.colors.error
							: theme.colors.success
					}
				>
					{message}
				</text>
			) : null}
		</box>
	);
}

const avatarUploadConfirmationSchema = z.object({
	success: z.boolean().optional(),
	avatarId: z.string().optional(),
});
