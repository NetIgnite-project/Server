<script setup lang="ts">
/**
 * Sign-up. Only works while an admin has enabled public registration (Server Settings);
 * otherwise the page explains that accounts are created by admins.
 */

import type { AuthFormField, FormError, FormSubmitEvent } from "@nuxt/ui";
import * as z from "zod";
import { useOnboardingStore } from "~/composables/stores/useOnboardingStore";
import { useUserInfoStore } from "~/composables/stores/useUserStore";

definePageMeta({
	layout: "auth",
});

useSeoMeta({
	title: "Sign Up | NetIgnite",
	description: "Create a new account",
});

const toast = useToast();

const fields: AuthFormField[] = [
	{
		name: "username",
		type: "text",
		label: "Username",
		placeholder: "Enter your username",
		required: true,
	},
	{
		name: "email",
		type: "email",
		label: "Email Address",
		placeholder: "Enter your email address",
		required: true,
	},
	{
		name: "password",
		label: "Password",
		type: "password",
		placeholder: "Enter your password",
		required: true,
	},
	{
		name: "confirm_password",
		label: "Confirm Password",
		type: "password",
		placeholder: "Re-enter your password",
		required: true,
	},
];

const schema = z.object({
	username: z
		.string("Username is required")
		.trim()
		.min(5, "Must be at least 5 characters")
		.max(40, "Must be at most 40 characters")
		.regex(/^[a-z0-9._-]+$/, "Only lowercase letters, numbers, dots, dashes and underscores"),
	email: z.email("Invalid email address").trim(),
	password: passwordRule,
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

const registration = await useAPIAsyncData("auth-registration", async () => {
	const res = await useAPI((api) => api.getAuthRegistration({}), true);
	return res.success ? res.data.enabled : false;
});

const loading = ref(false);

async function onSubmit(payload: FormSubmitEvent<Schema>) {
	loading.value = true;
	const result = await useAPI(
		(api) =>
			api.postAuthSignup({
				body: {
					username: payload.data.username,
					email: payload.data.email,
					password: payload.data.password,
				},
			}),
		true,
	);
	loading.value = false;

	if (!result.success) {
		toast.add({
			title: "Sign-up failed",
			description: result.message || "Please try again later.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
		return;
	}

	updateAPIClient(result.data.token);
	useAppCookies().sessionToken.set(result.data.token);
	await useUserInfoStore().refresh();
	await useOnboardingStore().clear();

	toast.add({
		title: "Welcome to NetIgnite",
		description: "Your account was created.",
		icon: "i-lucide-check",
		color: "success",
	});
	await navigateTo("/welcome");
}
</script>

<template>
	<UAuthForm
		:schema="schema"
		:validate="validate"
		title="Sign Up"
		description="Create a new account by filling in the information below."
		icon="i-lucide-user-plus"
		:fields="fields"
		:submit="{ label: 'Sign Up', loading, disabled: !registration.data.value }"
		@submit="onSubmit"
	>
		<template #footer>
			<div class="text-center text-sm">
				Already have an account?
				<NuxtLink to="/auth/login" class="text-primary hover:underline">Login here</NuxtLink>
			</div>
			<UAlert
				v-if="registration.data.value === false"
				color="warning"
				variant="subtle"
				title="Sign-up is disabled"
				description="Accounts on this server are created by an administrator."
				icon="i-lucide-lock"
				class="mt-4"
			/>
		</template>
	</UAuthForm>
</template>
