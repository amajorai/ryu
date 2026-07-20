import { z } from "zod";

export const nameSchema = z
	.string()
	.min(1, "Name is required")
	.max(50, "Name must be 50 characters or less");

export const emailSchema = z.string().email("Invalid email address");

export const passwordSchema = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
	.regex(/[0-9]/, "Password must contain at least one number")
	.regex(
		/[!@#$%^&*(),.?":{}|<>]/,
		"Password must contain at least one special character"
	);

export const emailChangeSchema = z.object({
	currentPassword: z.string().min(1, "Current password is required"),
	newEmail: emailSchema,
});

export const passwordChangeSchema = z.object({
	currentPassword: z.string().optional(),
	newPassword: passwordSchema,
});

export const profileSchema = z.object({
	name: nameSchema,
	email: emailSchema,
});
