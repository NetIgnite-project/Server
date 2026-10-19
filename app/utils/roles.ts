/**
 * Single source of truth for the badge color used to represent a user role,
 * so the admin user list and the settings page stay visually consistent.
 */
export function getRoleColor(role: string | null | undefined): "error" | "primary" | "neutral" {
	switch (role) {
		case "admin":
			return "error";
		case "user":
			return "primary";
		default:
			return "neutral";
	}
}
