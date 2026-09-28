import type { ApiKeyScope } from '@n8n/permissions';
import { Service } from '@n8n/di';
import { DataSource, In } from '@n8n/typeorm';
import type { ApiKeyAudience } from 'n8n-workflow';

import { BaseRepository } from './base-repository';
import { ApiKey } from '../entities';
import type { OperationContext } from '../services/transaction';
import { TransactionRunner } from '../services/transaction';

@Service()
export class ApiKeyRepository extends BaseRepository<ApiKey> {
	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		super(ApiKey, dataSource.manager, transactionRunner);
	}

	async findEnvManaged(ctx: OperationContext): Promise<ApiKey | null> {
		return await this.managerFor(ctx).findOne(ApiKey, {
			where: { managedByEnv: true, audience: 'public-api' },
		});
	}

	async deleteEnvManaged(ctx: OperationContext): Promise<ApiKey[]> {
		const manager = this.managerFor(ctx);
		const apiKeys = await manager.find(ApiKey, { where: { managedByEnv: true } });
		if (apiKeys.length > 0) {
			await manager.delete(ApiKey, { id: In(apiKeys.map(({ id }) => id)) });
		}
		return apiKeys;
	}

	async findByValue(apiKey: string, ctx: OperationContext): Promise<ApiKey | null> {
		return await this.managerFor(ctx).findOne(ApiKey, { where: { apiKey } });
	}

	async findByOwnerAndLabel(
		userId: string,
		label: string,
		ctx: OperationContext,
	): Promise<ApiKey | null> {
		return await this.managerFor(ctx).findOne(ApiKey, { where: { userId, label } });
	}

	async insertEnvManaged(
		data: {
			userId: string;
			apiKey: string;
			label: string;
			scopes: ApiKeyScope[];
			audience: ApiKeyAudience;
		},
		ctx: OperationContext,
	): Promise<ApiKey> {
		const manager = this.managerFor(ctx);
		const entity = manager.create(ApiKey, { ...data, managedByEnv: true, lastUsedAt: null });
		return await manager.save(ApiKey, entity);
	}

	async updateEnvManaged(
		id: string,
		changes: Partial<Pick<ApiKey, 'apiKey' | 'scopes' | 'lastUsedAt'>>,
		ctx: OperationContext,
	): Promise<void> {
		await this.managerFor(ctx).update(ApiKey, { id, managedByEnv: true }, changes);
	}
}
