<script setup lang="ts">
import type { AuthFormField, FormError, FormSubmitEvent } from "@nuxt/ui";
import * as z from "zod";

definePageMeta({
	layout: "auth",
});

useSeoMeta({
	title: "Reset Password | NetIgnite",
	description: "Reset your password",
});

const route = useRoute();
const toast = useToast();

// The emailed link is `{APP_URL}/auth/reset-password?token=…` (see docs/10-auth.md).
const resetToken = route.query.token?.toString() ?? "";

const fields: AuthFormField[] = [
	{
		name: "password",
		label: "New Password",
		type: "password",
		placeholder: "Enter a new password",
		required: true,
	},
	{
		name: "confirm_password",
		label: "Confirm New Password",
		type: "password",
		placeholder: "Re-enter your new password",
		required: true,
	},
];

const schema = z.object({
	password: z
		.string("Password is required")
		.min(8, "Must be at least 8 characters")
		.max(128, "Must be at most 128 characters"),
	confirm_password: z.string("Confirm Password is required").min(1, "Confirm Password is required"),
});

type Schema = z.output<typeof schema>;

function validate(state: Partial<Schema>): FormError[] {
	const errors: FormError[] = [];
	if (state.password && state.confirm_password && state.password !== state.confirm_password) {
		errors.push({ name: "confirm_password", message: "Passwords do not match" });
	}
	return errors;
}

const loading = ref(false);

async function onSubmit(payload: FormSubmitEvent<Schema>) {
	loading.value = true;

	const result = await useAPI(
		(api) =>
			api.postAuthResetPassword({
				body: {
					reset_token: resetToken,
					new_password: payload.data.password,
				},
			}),
		true,
	);

	loading.value = false;

	if (result.success) {
		toast.add({
			title: "Password Reset Successful",
			description: "Your password has been reset. You can now log in.",
			icon: "i-lucide-check",
			color: "success",
		});
		await navigateTo("/auth/login");
	} else {
		toast.add({
			title: "Password Reset Failed",
			description: result.message || "The reset link may be invalid or expired.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
	}
}
</script>

<template>
	<UAuthForm
		v-if="resetToken"
		:schema="schema"
		:validate="validate"
		title="Reset Password"
		description="Enter your new password below to reset it."
		icon="i-lucide-key-round"
		:fields="fields"
		:submit="{ label: 'Reset Password', loading }"
		@submit="onSubmit"
	>
		<template #footer>
			<div class="text-center text-sm">
				Remembered your password?
				<NuxtLink to="/auth/login" class="text-primary hover:underline">Login here</NuxtLink>
			</div>
		</template>
	</UAuthForm>

	<div v-else class="space-y-4 text-center">
		<p>
			Invalid or missing reset token. Please check your reset link or request a new password
			reset.
		</p>
		<NuxtLink to="/auth/forgot-password" class="text-primary hover:underline">
			Request a new password reset
		</NuxtLink>
	</div>
</template>
