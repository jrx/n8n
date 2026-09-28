import { nanoid } from 'nanoid';

import { INSTANCE_OWNER_CREDENTIALS } from '../../../config/test-users';
import { test as base, expect } from '../../../fixtures/base';

const test = base.extend({
	// The default reset deletes the owner and the key created by the startup loader.
	dbSetup: [async ({}, use) => await use(undefined), { scope: 'worker' }],
});

test.use({
	capability: {
		env: {
			N8N_INSTANCE_OWNER_MANAGED_BY_ENV: 'true',
			N8N_INSTANCE_OWNER_EMAIL: INSTANCE_OWNER_CREDENTIALS.email,
			N8N_INSTANCE_OWNER_FIRST_NAME: 'Instance',
			N8N_INSTANCE_OWNER_LAST_NAME: 'Owner',
			// Bcrypt hash of DEFAULT_USER_PASSWORD for this disposable instance.
			N8N_INSTANCE_OWNER_PASSWORD_HASH:
				'$2a$10$9Gs.5EERwfkecTBe/eo17.URe3gIMNd2EHz/iS.PIRWnQ/IPkhdsS',
			N8N_INSTANCE_API_KEY_MANAGED_BY_ENV: 'true',
			N8N_INSTANCE_API_KEY: `n8n_api_${'a'.repeat(64)}`,
		},
	},
});

test.describe(
	'Environment-managed API key',
	{
		annotation: [{ type: 'owner', description: 'Identity & Access' }],
	},
	() => {
		test('keeps the startup key read-only and ordinary keys editable', async ({ n8n }) => {
			const ordinaryLabel = `Ordinary key ${nanoid()}`;
			await n8n.api.publicApi.createApiKey(ordinaryLabel, ['workflow:list']);
			await n8n.start.fromHome();
			await n8n.settingsApi.goto();

			const settings = n8n.settingsApi;
			const managedLabel = 'Owner API key';
			await expect(settings.getManagedBadge(managedLabel)).toHaveText('Managed by environment');
			await expect(settings.getRowActions(managedLabel)).toBeHidden();
			await expect(settings.getManagedBadge(ordinaryLabel)).toBeHidden();
			await expect(settings.getRowActions(ordinaryLabel)).toBeVisible();

			await settings.getRow(managedLabel).click();
			await expect(settings.getModal()).toBeVisible();
			await expect(settings.getLabelInput()).toBeDisabled();
			await expect(settings.getLabelInput()).toHaveValue(managedLabel);
			for (const mode of ['All', 'Read only', 'Custom']) {
				await expect(settings.getScopeMode(mode)).toBeDisabled();
			}
			await expect(settings.getSaveButton()).toBeHidden();
			await expect(settings.getRevokeButton()).toBeHidden();
			await settings.closeReadOnlyModal();

			await settings.getRow(ordinaryLabel).click();
			await expect(settings.getLabelInput()).toBeEditable();
			await expect(settings.getSaveButton()).toBeEnabled();
		});
	},
);
