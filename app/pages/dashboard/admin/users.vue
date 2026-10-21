<script setup lang="ts">
import type { DropdownMenuItem, FormSubmitEvent, TableColumn } from "@nuxt/ui";
import type { z } from "zod";
import type { GetAdminUsersResponses } from "~/api-client";
import { zPostAdminUsersBody } from "~/api-client/zod.gen";

type AdminUser = GetAdminUsersResponses["200"]["data"][number];
type UserRole = AdminUser["role"];

// Admin-only: `auth.global.ts` redirects non-admins away from /dashboard/admin/*.
definePageMeta({
	layout: "dashboard",
});

useSeoMeta({
	title: "Users | NetIgnite",
	description: "Manage users",
});

const toast = useToast();

const columns: TableColumn<AdminUser>[] = [
	{ accessorKey: "id", header: "ID" },
	{ accessorKey: "username", header: "Username" },
	{ accessorKey: "display_name", header: "Display Name" },
	{ accessorKey: "email", header: "Email" },
	{ accessorKey: "role", header: "Role" },
	{ id: "actions", header: "", enableSorting: false, enableHiding: false },
];

const roleOptions: { label: string; value: UserRole }[] = [
	{ label: "Admin", value: "admin" },
	{ label: "User", value: "user" },
];

const {
	data: users,
	loading,
	refresh,
} = await useAPILazyAsyncData<AdminUser[]>("admin-users-list", async () => {
	const res = await useAPI((api) => api.getAdminUsers({}));
	if (!res.success) {
		toast.add({ title: "Failed to load users", description: res.message, color: "error" });
		return [];
	}
	return res.data;
});

function getRowActions(user: AdminUser): DropdownMenuItem[][] {
	return [
		[
			{ label: "Edit", icon: "i-lucide-pencil", onSelect: () => openEdit(user) },
			{ label: "Reset Password", icon: "i-lucide-key", onSelect: () => openPassword(user) },
		],
		[
			{
				label: "Delete",
				icon: "i-lucide-trash-2",
				color: "error",
				onSelect: () => openDelete(user),
			},
		],
	];
}

// Create
const showCreateModal = ref(false);
// Referenced here (not only in the template) so Biome keeps it a value import.
const createSchema = zPostAdminUsersBody;
type CreateSchema = z.output<typeof createSchema>;

function emptyCreateForm(): CreateSchema {
	return { username: "", display_name: "", email: "", password: "", role: "user" };
}
const createForm = reactive<CreateSchema>(emptyCreateForm());

async function handleCreate(event: FormSubmitEvent<CreateSchema>) {
	const res = await useAPI((api) => api.postAdminUsers({ body: event.data }));
	if (!res.success) {
		toast.add({ title: "Create failed", description: res.message, color: "error" });
		return;
	}
	showCreateModal.value = false;
	Object.assign(createForm, emptyCreateForm());
	toast.add({ title: "User created", color: "success" });
	await refresh();
}

// Edit
const showEditModal = ref(false);
const selectedUser = ref<AdminUser | null>(null);
const editForm = reactive({
	display_name: "",
	email: "",
	role: "user" as UserRole,
});

function openEdit(user: AdminUser) {
	selectedUser.value = user;
	editForm.display_name = user.display_name;
	editForm.email = user.email;
	editForm.role = user.role;
	showEditModal.value = true;
}

async function submitEdit() {
	const target = selectedUser.value;
	if (!target) return;

	const res = await useAPI((api) =>
		api.putAdminUsersByUserId({
			path: { userId: target.id },
			body: { display_name: editForm.display_name, email: editForm.email, role: editForm.role },
		}),
	);
	if (!res.success) {
		toast.add({ title: "Update failed", description: res.message, color: "error" });
		return;
	}
	toast.add({ title: "User updated", color: "success" });
	showEditModal.value = false;
	await refresh();
}

// Reset password
const showPasswordModal = ref(false);
const passwordForm = reactive({ password: "" });

function openPassword(user: AdminUser) {
	selectedUser.value = user;
	passwordForm.password = "";
	showPasswordModal.value = true;
}

async function submitPassword() {
	const target = selectedUser.value;
	if (!target) return;

	const res = await useAPI((api) =>
		api.putAdminUsersByUserIdPassword({
			path: { userId: target.id },
			body: { password: passwordForm.password },
		}),
	);
	if (!res.success) {
		toast.add({ title: "Update failed", description: res.message, color: "error" });
		return;
	}
	toast.add({ title: "Password updated", color: "success" });
	showPasswordModal.value = false;
}

// Delete
const deleteConfirmOpen = ref(false);
const deleteTarget = ref<AdminUser | null>(null);

function openDelete(user: AdminUser) {
	deleteTarget.value = user;
	deleteConfirmOpen.value = true;
}

async function onDeleteUser() {
	const target = deleteTarget.value;
	if (!target) return;

	const res = await useAPI((api) => api.deleteAdminUsersByUserId({ path: { userId: target.id } }));
	if (!res.success) {
		toast.add({ title: "Delete failed", description: res.message, color: "error" });
		throw new Error(res.message);
	}
	toast.add({ title: "User deleted", color: "success" });
	deleteTarget.value = null;
	await refresh();
}
</script>

<template>
	<UDashboardPanel>
		<template #header>
			<DashboardPageHeader title="Users" icon="i-lucide-users" description="Manage users" />
		</template>

		<template #body>
			<DashboardPageBody>
				<DashboardDataTable
					:data="users ?? []"
					:columns="columns"
					:loading="loading"
					:filters="[
						{
							column: 'username',
							type: 'text',
							placeholder: 'Search users...',
							icon: 'i-lucide-search',
						},
						{
							column: 'role',
							type: 'select',
							placeholder: 'All Roles',
							icon: 'i-lucide-filter',
							options: roleOptions,
						},
					]"
					empty-title="No users"
					empty-description="Create your first user to get started."
					empty-icon="i-lucide-users"
					@refresh="refresh"
				>
					<template #header-right>
						<UButton label="New User" icon="i-lucide-user-plus" color="primary" @click="showCreateModal = true" />
					</template>

					<template #id-cell="{ row }">
						<span class="font-mono text-sm">#{{ row.original.id }}</span>
					</template>

					<template #username-cell="{ row }">
						<div class="flex items-center gap-2">
							<Gravatar :email="row.original.email" :alt="row.original.display_name" size="sm" />
							<span class="font-medium">{{ row.original.username }}</span>
						</div>
					</template>

					<template #email-cell="{ row }">
						<span class="text-slate-400">{{ row.original.email }}</span>
					</template>

					<template #role-cell="{ row }">
						<UBadge :color="getRoleColor(row.original.role)" variant="soft">{{ row.original.role }}</UBadge>
					</template>

					<template #actions-cell="{ row }">
						<UDropdownMenu :ui="{ viewport: 'main-bg-color' }" :items="getRowActions(row.original)">
							<UButton icon="i-lucide-more-horizontal" variant="ghost" color="neutral" size="xs" aria-label="User actions" />
						</UDropdownMenu>
					</template>

					<template #empty-actions>
						<UButton label="Create User" color="primary" @click="showCreateModal = true" />
					</template>
				</DashboardDataTable>
			</DashboardPageBody>
		</template>
	</UDashboardPanel>

	<!-- Create user -->
	<DashboardModal v-model:open="showCreateModal" title="Create User" icon="i-lucide-user-plus">
		<UForm :schema="createSchema" :state="createForm" class="space-y-4" @submit="handleCreate">
			<UFormField label="Username" name="username" required>
				<UInput v-model="createForm.username" placeholder="johndoe" class="w-full" />
			</UFormField>
			<UFormField label="Display Name" name="display_name" required>
				<UInput v-model="createForm.display_name" placeholder="John Doe" class="w-full" />
			</UFormField>
			<UFormField label="Email" name="email" required>
				<UInput v-model="createForm.email" type="email" placeholder="john@example.com" class="w-full" />
			</UFormField>
			<UFormField label="Password" name="password" required>
				<UInput v-model="createForm.password" type="password" placeholder="••••••••" class="w-full" />
			</UFormField>
			<UFormField label="Role" name="role" required>
				<USelect v-model="createForm.role" :items="roleOptions" class="w-full" />
			</UFormField>

			<div class="flex justify-end gap-2 pt-4">
				<UButton label="Cancel" color="neutral" variant="ghost" @click="showCreateModal = false" />
				<UButton type="submit" label="Create" color="primary" />
			</div>
		</UForm>
	</DashboardModal>

	<!-- Edit user -->
	<DashboardModal v-model:open="showEditModal" :title="`Edit User: ${selectedUser?.username}`" icon="i-lucide-pencil">
		<div class="space-y-4">
			<UFormField label="Display Name">
				<UInput v-model="editForm.display_name" class="w-full" />
			</UFormField>
			<UFormField label="Email">
				<UInput v-model="editForm.email" type="email" class="w-full" />
			</UFormField>
			<UFormField label="Role">
				<USelect v-model="editForm.role" :items="roleOptions" class="w-full" />
			</UFormField>

			<div class="flex justify-end gap-2 pt-4">
				<UButton label="Cancel" color="neutral" variant="ghost" @click="showEditModal = false" />
				<UButton label="Save" color="primary" @click="submitEdit" />
			</div>
		</div>
	</DashboardModal>

	<!-- Reset password -->
	<DashboardModal
		v-model:open="showPasswordModal"
		:title="`Reset Password: ${selectedUser?.username}`"
		icon="i-lucide-key"
		icon-color="amber"
	>
		<div class="space-y-4">
			<UFormField label="New Password" :description="PASSWORD_HINT">
				<UInput v-model="passwordForm.password" type="password" placeholder="••••••••" class="w-full" />
			</UFormField>

			<div class="flex justify-end gap-2 pt-4">
				<UButton label="Cancel" color="neutral" variant="ghost" @click="showPasswordModal = false" />
				<UButton label="Update Password" color="primary" @click="submitPassword" />
			</div>
		</div>
	</DashboardModal>

	<!-- Delete user -->
	<DashboardDeleteModal
		v-model:open="deleteConfirmOpen"
		title="Delete User"
		:warning-text="`User &quot;${deleteTarget?.username ?? ''}&quot; and all their data will be permanently deleted.`"
		:on-delete="onDeleteUser"
	/>
</template>
