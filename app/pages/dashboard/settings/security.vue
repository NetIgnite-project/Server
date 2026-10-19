<script setup lang="ts">
import type { FormError, FormSubmitEvent } from "@nuxt/ui";
import * as z from "zod";
import { useUserInfoStore } from "~/composables/stores/useUserStore";

const toast = useToast();

const passwordSchema = z.object({
	current_password: z.string("Current Password is required").min(1, "Current Password is required"),
	new_password: z
		.string("Password is required")
		.min(8, "Must be at least 8 characters")
		.max(128, "Must be at most 128 characters"),
	confirm_password: z.string("Confirm Password is required").min(1, "Confirm Password is required"),
});

type PasswordSchema = z.output<typeof passwordSchema>;

const password = reactive<Partial<PasswordSchema>>({
	current_password: undefined,
	new_password: undefined,
	confirm_password: undefined,
});

function validate(state: Partial<PasswordSchema>): FormError[] {
	const errors: FormError[] = [];
	if (
		state.current_password &&
		state.new_password &&
		state.current_password === state.new_password
	) {
		errors.push({
			name: "new_password",
			message: "New password must be different from current password",
		});
	}
	if (
		state.new_password &&
		state.confirm_password &&
		state.new_password !== state.confirm_password
	) {
		errors.push({ name: "confirm_password", message: "Passwords do not match" });
	}
	return errors;
}

const passwordLoading = ref(false);

/** Drop the local session after the server invalidated it. */
async function endSession(redirectTo: string) {
	await useUserInfoStore().clear();
	useAppCookies().sessionToken.set(null);
	await navigateTo(redirectTo);
}

async function onPasswordSubmit(event: FormSubmitEvent<PasswordSchema>) {
	passwordLoading.value = true;

	const result = await useAPI((api) =>
		api.putAccountPassword({
			body: {
				current_password: event.data.current_password,
				new_password: event.data.new_password,
			},
		}),
	);

	passwordLoading.value = false;

	if (result.success) {
		toast.add({
			title: "Password updated",
			description: "Your password has been successfully updated. Please log in again.",
			icon: "i-lucide-check",
			color: "success",
		});
		await endSession("/auth/login");
	} else {
		toast.add({
			title: "Error",
			description: result.message || "An error occurred while updating your password.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
	}
}

const deleteConfirmOpen = ref(false);

async function onDeleteAccount() {
	const result = await useAPI((api) => api.deleteAccount({}));

	if (!result.success) {
		toast.add({
			title: "Error",
			description: result.message || "An error occurred while deleting your account.",
			icon: "i-lucide-alert-circle",
			color: "error",
		});
		// Throwing keeps the delete modal open (see DashboardDeleteModal).
		throw new Error(result.message);
	}

	toast.add({
		title: "Account deleted",
		description: "Your account has been permanently deleted.",
		icon: "i-lucide-check",
		color: "success",
	});
	await endSession("/");
}
</script>

<template>
	<div class="space-y-6">
		<div>
			<h2 class="text-xl font-semibold text-white">Security Settings</h2>
			<p class="mt-1 text-sm text-slate-400">Manage your password and account security</p>
		</div>

		<DashboardSectionCard
			title="Change Password"
			description="Update your password to keep your account secure"
			icon="i-lucide-key-round"
		>
			<UForm
				:schema="passwordSchema"
				:state="password"
				:validate="validate"
				class="divide-y divide-slate-800"
				@submit="onPasswordSubmit"
			>
				<UFormField
					name="current_password"
					label="Current Password"
					description="Enter your current password to verify."
					required
					class="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-auto' }"
				>
					<UInput
						v-model="password.current_password"
						type="password"
						placeholder="Current password"
						class="w-full sm:w-96"
					/>
				</UFormField>

				<UFormField
					name="new_password"
					label="New Password"
					description="At least 8 characters."
					required
					class="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-auto' }"
				>
					<UInput
						v-model="password.new_password"
						type="password"
						placeholder="New password"
						class="w-full sm:w-96"
					/>
				</UFormField>

				<UFormField
					name="confirm_password"
					label="Confirm Password"
					description="Re-enter your new password."
					required
					class="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0 max-sm:flex-col"
					:ui="{ root: 'w-full sm:w-auto', container: 'w-full sm:w-auto' }"
				>
					<UInput
						v-model="password.confirm_password"
						type="password"
						placeholder="Confirm password"
						class="w-full sm:w-96"
					/>
				</UFormField>

				<div class="pt-4">
					<UButton
						label="Update Password"
						type="submit"
						color="primary"
						:loading="passwordLoading"
						icon="i-lucide-lock"
					/>
				</div>
			</UForm>
		</DashboardSectionCard>

		<DashboardSectionCard
			title="Danger Zone"
			description="Irreversible and destructive actions"
			icon="i-lucide-alert-triangle"
			tone="danger"
		>
			<div class="flex flex-col gap-4 md:flex-row md:items-center">
				<div class="flex-1">
					<h4 class="font-medium text-white">Delete Account</h4>
					<p class="mt-1 text-sm text-slate-400">
						Permanently delete your account and all associated data. This action cannot be undone.
					</p>
				</div>
				<UButton
					label="Delete Account"
					color="error"
					variant="soft"
					icon="i-lucide-trash-2"
					@click="deleteConfirmOpen = true"
				/>
			</div>
		</DashboardSectionCard>

		<DashboardDeleteModal
			v-model:open="deleteConfirmOpen"
			title="Delete Account"
			warning-text="All your data and account information will be permanently deleted. This action cannot be reversed."
			:on-delete="onDeleteAccount"
		/>
	</div>
</template>
