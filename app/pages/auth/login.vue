<script setup lang="ts">
import type { AuthFormField, FormSubmitEvent } from "@nuxt/ui";
import * as z from "zod";
import { useOnboardingStore } from "~/composables/stores/useOnboardingStore";
import { useUserInfoStore } from "~/composables/stores/useUserStore";

definePageMeta({
	layout: "auth",
});

useSeoMeta({
	title: "Login | NetIgnite",
	description: "Login to your account",
});

const route = useRoute();
const toast = useToast();

// Only follow internal redirects (`/…`, not `//evil.example`); default to the dashboard.
const requestedUrl = route.query.url?.toString() ?? "";
const redirectUrl =
	requestedUrl.startsWith("/") && !requestedUrl.startsWith("//") ? requestedUrl : "/dashboard";

const fields: AuthFormField[] = [
	{
		name: "username",
		type: "text",
		label: "Username",
		placeholder: "Enter your username",
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
		name: "remember",
		label: "Remember me",
		type: "checkbox",
		description: "You will stay logged in for 7 days.",
	},
];

const schema = z.object({
	username: z.string("Username is required").trim().min(1, "Username is required"),
	password: z.string("Password is required").min(1, "Password is required"),
	remember: z.boolean().optional(),
});

type Schema = z.output<typeof schema>;

const loading = ref(false);

// The sign-up link is only shown while an admin has enabled public registration.
const registration = await useAPILazyAsyncData("auth-registration", async () => {
	const res = await useAPI((api) => api.getAuthRegistration({}), true);
	return res.success ? res.data.enabled : false;
});

async function onSubmit(payload: FormSubmitEvent<Schema>) {
	loading.value = true;

	const result = await useAPI(
		(api) =>
			api.postAuthLogin({
				body: { username: payload.data.username, password: payload.data.password },
			}),
		true,
	);

	loading.value = false;

	if (!result.success) {
		const invalidCredentials = (result.code as number) === 401;
		toast.add({
			title: invalidCredentials ? "Invalid Username or Password" : "Login Failed",
			description: invalidCredentials
				? "Please check your credentials and try again."
				: result.message || "An error occurred during login. Please try again later.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
		return;
	}

	updateAPIClient(result.data.token);
	useAppCookies().sessionToken.set(result.data.token, {
		// As long as the session lasts (7 days, server/lib/api/utils/authHandler.ts), only with "remember me"
		maxAge: payload.data.remember ? 60 * 60 * 24 * 7 : undefined,
	});

	// Fresh per-user state for the new session.
	await useUserInfoStore().refresh();
	await useOnboardingStore().clear();

	toast.add({
		title: "Login Successful",
		description: "You have been logged in successfully.",
		icon: "i-lucide-check",
		color: "success",
	});

	await navigateTo(redirectUrl);
}
</script>

<template>
	<UAuthForm
		:schema="schema"
		title="Login"
		description="Enter your credentials to access your account."
		icon="i-lucide-user"
		:fields="fields"
		:submit="{ label: 'Login', loading }"
		@submit="onSubmit"
	>
		<template #footer>
			<div class="text-center text-sm">
				Forgot your password?
				<NuxtLink to="/auth/forgot-password" class="text-primary hover:underline">
					Reset here
				</NuxtLink>
			</div>
			<div v-if="registration.data.value" class="mt-2 text-center text-sm">
				Don't have an account?
				<NuxtLink to="/auth/signup" class="text-primary hover:underline">Sign up</NuxtLink>
			</div>
		</template>
	</UAuthForm>
</template>
