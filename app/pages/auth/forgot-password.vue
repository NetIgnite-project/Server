<script setup lang="ts">
import type { AuthFormField, FormSubmitEvent } from "@nuxt/ui";
import * as z from "zod";

definePageMeta({
	layout: "auth",
});

useSeoMeta({
	title: "Forgot Password | NetIgnite",
	description: "Reset your password",
});

const toast = useToast();

const fields: AuthFormField[] = [
	{
		name: "email",
		type: "email",
		label: "Email Address",
		placeholder: "Enter your email address",
		required: true,
	},
];

const schema = z.object({
	email: z.email("Invalid email address").trim(),
});

type Schema = z.output<typeof schema>;

const submitted = ref(false);
const loading = ref(false);

async function onSubmit(payload: FormSubmitEvent<Schema>) {
	if (loading.value) return;
	loading.value = true;

	const result = await useAPI(
		(api) => api.postAuthResetPasswordRequest({ body: payload.data }),
		true,
	);

	loading.value = false;

	if (result.success) {
		submitted.value = true;
	} else {
		toast.add({
			title: "Request Failed",
			description: result.message || "An error occurred. Please try again later.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
	}
}
</script>

<template>
	<UAuthForm
		v-if="!submitted"
		:schema="schema"
		title="Forgot Password"
		description="Reset your password by entering your email address below."
		icon="i-lucide-mail"
		:fields="fields"
		:submit="{ label: loading ? 'Sending...' : 'Send Reset Link', loading, disabled: loading }"
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
		<div class="flex justify-center">
			<div class="rounded-full bg-primary/10 p-3">
				<UIcon name="i-lucide-mail-check" class="size-8 text-primary" />
			</div>
		</div>
		<h2 class="text-xl font-semibold">Check Your Email</h2>
		<p class="mx-auto max-w-sm text-sm text-slate-400">
			If an account with that email address exists, we've sent a password reset link. Please
			check your inbox and follow the instructions.
		</p>
		<p class="text-xs text-slate-400">
			Didn't receive an email?
			<button type="button" class="text-primary hover:underline" @click="submitted = false">
				Try again
			</button>
		</p>
		<div class="pt-4">
			<NuxtLink to="/auth/login" class="text-sm text-primary hover:underline">Back to login</NuxtLink>
		</div>
	</div>
</template>
