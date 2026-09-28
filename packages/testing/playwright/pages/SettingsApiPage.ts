import { BasePage } from './BasePage';

export class SettingsApiPage extends BasePage {
	async goto() {
		await this.page.goto('/settings/api');
	}

	getRow(label: string) {
		return this.page.getByTestId('api-key-table').getByRole('row').filter({ hasText: label });
	}

	getManagedBadge(label: string) {
		return this.getRow(label).getByTestId('api-key-managed-by-env-badge');
	}

	getRowActions(label: string) {
		return this.getRow(label).getByTestId('api-key-actions-toggle');
	}

	getModal() {
		return this.page.getByRole('dialog');
	}

	getLabelInput() {
		return this.getModal().getByTestId('api-key-label');
	}

	getScopeMode(name: string) {
		return this.getModal().getByRole('radio', { name: new RegExp(`^${name}`) });
	}

	getSaveButton() {
		return this.getModal().getByRole('button', { name: 'Save', exact: true });
	}

	getRevokeButton() {
		return this.getModal().getByTestId('api-key-readonly-revoke');
	}

	async closeReadOnlyModal() {
		await this.getModal().getByTestId('api-key-readonly-close').click();
	}
}
