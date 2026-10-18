<script setup lang="ts">
import DashboardPage from '@/components/DashboardPage.vue';
import { Agent } from '@/utils/models/agent';
import FormDescription from '~/components/forms/FormDescription.vue';
import FormGroup from '~/components/forms/FormGroup.vue';
import FormInput from '~/components/forms/FormInput.vue';
import FormLabel from '~/components/forms/FormLabel.vue';
import FormPWInput from '~/components/forms/FormPWInput.vue';
import FormSelect from '~/components/forms/FormSelect.vue';
import FormSubmitBtn from '~/components/forms/FormSubmitBtn.vue';
import FormTextarea from '~/components/forms/FormTextarea.vue';
import { useAPI } from '~/composables/useAPI';
import { SessionStore } from '~/utils/userStore';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});


const route = useRoute();
const agent_id = route.params.id;

const isNewAgent = agent_id === "new";

const initialNotification = ref<NotificationToastSettings | null>(null);

// The server returns an agent's secret only when it is created or regenerated. After creating an
// agent, the secret is handed over to the agent's page through this state and shown once.
const newAgentSecret = useState<{ id: number; secret: string } | null>('new-agent-secret', () => null);

async function getAgent() {

    if (isNewAgent) {
        return new Agent({
            id: -1,
            name: "",
            description: "",
            type: "" as any,
            ownerID: SessionStore.useUserInfo().userID,
            status: 'unknown',
        });
    }

    const response = await useAPI(`/api/agents/${agent_id}` as `/api/agents/:id`, {
        method: 'GET'
    });

    if (response.status !== "OK" || !response.data) {
        initialNotification.value = {
            message: `Error fetching agent: ${response?.message || 'unknown error'}`,
            type: 'error'
        };
        return {} as Agent;
    }
    return new Agent({
        ...response.data,
        status: 'unknown',
    });
}

const agent = reactive(await getAgent());

const revealedSecret = ref<string | null>(
    newAgentSecret.value && newAgentSecret.value.id === agent.id ? newAgentSecret.value.secret : null
);
newAgentSecret.value = null;

const isRegenerating = ref(false);

function getAgentInput() {
    return {
        name: agent.name,
        type: agent.type,
        description: agent.description,
    };
}

async function sumbitForm() {

    try {

        if (isNewAgent) {
            const response = await useAPI('/api/agents', {
                method: 'POST',
                body: JSON.stringify(getAgentInput())
            });

            if (response.status !== "OK" || !response.data) {
                useNotificationToast({
                    message: `Error creating agent: ${response?.message || 'unknown error'}`,
                    type: 'error'
                });
                return;
            }
            useNotificationToast({
                message: 'Agent created successfully',
                type: 'success'
            });
            newAgentSecret.value = response.data;
            navigateTo(`/agents/${response.data.id}`, { replace: true });

        } else {

            const response = await useAPI(`/api/agents/${agent.id}`, {
                method: 'PUT',
                body: JSON.stringify(getAgentInput())
            });

            if (response.status !== "OK") {
                useNotificationToast({
                    message: `Error updating agent: ${response?.message || 'unknown error'}`,
                    type: 'error'
                });
                return;
            }
            useNotificationToast({
                message: 'Agent updated successfully',
                type: 'success'
            });
            navigateTo(`/agents/`);
        }

    } catch (error) {
        useNotificationToast({
            message: `Error: ${error instanceof Error ? error.message : 'unknown error'}`,
            type: 'error'
        });
    }

}

async function regenerateSecret() {

    if (!confirm('Generate a new secret? The agent is disconnected and can only reconnect once it is configured with the new secret.')) {
        return;
    }

    isRegenerating.value = true;
    try {
        const response = await useAPI(`/api/agents/${agent.id}/regenerate-secret` as `/api/agents/:id/regenerate-secret`, {
            method: 'POST'
        });

        if (response.status !== "OK" || !response.data) {
            useNotificationToast({
                message: `Error regenerating secret: ${response?.message || 'unknown error'}`,
                type: 'error'
            });
            return;
        }

        revealedSecret.value = response.data.secret;
        useNotificationToast({
            message: 'New secret generated. Copy it now, it is only shown once.',
            type: 'success'
        });
    } finally {
        isRegenerating.value = false;
    }
}

async function copySecret() {
    if (!revealedSecret.value) return;
    try {
        await navigator.clipboard.writeText(revealedSecret.value);
        useNotificationToast({ message: 'Secret copied to clipboard', type: 'success' });
    } catch {
        useNotificationToast({ message: 'Could not copy the secret. Reveal it and copy it manually.', type: 'error' });
    }
}

const isSubmitDisabled = computed(() => {
    return !agent.name || !agent.type;
});

onMounted(() => {
    if (initialNotification.value && import.meta.client) {
        useNotificationToast(initialNotification.value);
        navigateTo('/agents');
    }
});

</script>

<template>

    <DashboardPage v-if="!initialNotification" :title="isNewAgent ? 'Create New Agent' : 'Edit Agent'" subtitle="Manage your agent details" image="bi bi-wifi">

        <form @submit.prevent="sumbitForm" autocomplete="off">

            <div class="box-container d-flex flex-column justify-content-center">

                <h4 class="text-white mb-4">Resource Details</h4>

                <div class="row">
                    <FormGroup class="col-md-6">
                        <FormLabel>Name</FormLabel>
                        <FormInput id="agentName" v-model="agent.name" placeholder="Enter agent name" required />
                        <FormDescription>
                            The name of the agent. This is used to identify the agent in the dashboard.
                        </FormDescription>
                    </FormGroup>
                    <FormGroup class="col-md-6">
                        <FormLabel class="form-label">Agent Type</FormLabel>
                        <FormSelect v-model="agent.type" required>
                            <option value="" disabled>Select Agent Type</option>
                            <option v-for="type in Agent.Utils.getAllAgentTypes()" :value="type.name">
                                {{ type.label }}
                            </option>
                        </FormSelect>
                    </FormGroup>
                    <FormGroup class="col-md-12">
                        <FormLabel class="form-label">Description</FormLabel>
                        <FormTextarea rows="2" v-model="agent.description" placeholder="Enter agent description"></FormTextarea>
                    </FormGroup>
                </div>

                <div class="d-flex justify-content-end mt-4">
                    <FormSubmitBtn class="btn btn-primary text-right" type="submit" :disabled="isSubmitDisabled">
                        {{ isNewAgent ? 'Create Agent' : 'Update Agent' }}
                    </FormSubmitBtn>
                </div>

            </div>

            <div v-if="!isNewAgent" class="box-container d-flex flex-column justify-content-center mt-4">

                <h4 class="text-white mb-4">Connection Details</h4>

                <div class="row mb-2">
                    <FormGroup class="col-md-6">
                        <FormLabel>Connection ID</FormLabel>
                        <FormInput v-model="agent.id" disabled />
                    </FormGroup>
                    <FormGroup class="col-md-6">
                        <FormLabel>Connection Secret</FormLabel>
                        <template v-if="revealedSecret">
                            <FormPWInput v-model="revealedSecret" readonly />
                            <FormDescription>
                                Configure your agent with this secret now. For security reasons it is only
                                stored as a hash and can't be shown again.
                            </FormDescription>
                        </template>
                        <template v-else>
                            <FormInput model-value="Hidden" disabled />
                            <FormDescription>
                                The secret is only shown once, when the agent is created. If you lost it,
                                generate a new one.
                            </FormDescription>
                        </template>
                    </FormGroup>
                </div>

                <div class="d-flex justify-content-end gap-2">
                    <button v-if="revealedSecret" type="button" class="btn btn-secondary" @click="copySecret">
                        <i class="bi bi-clipboard me-1"></i>
                        Copy Secret
                    </button>
                    <button type="button" class="btn btn-warning" :disabled="isRegenerating" @click="regenerateSecret">
                        <i class="bi bi-arrow-repeat me-1"></i>
                        Regenerate Secret
                    </button>
                </div>

            </div>

        </form>

    </DashboardPage>

    <div></div>

</template>

<style scoped>

</style>
