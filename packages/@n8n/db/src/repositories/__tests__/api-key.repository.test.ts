import { In, type EntityManager } from '@n8n/typeorm';
import { mock } from 'vitest-mock-extended';

import { ApiKey } from '../../entities';
import type { TransactionRunner } from '../../services/transaction';
import { TypeOrmTransaction } from '../../services/typeorm-transaction';
import { mockEntityManager } from '../../utils/test-utils/mock-entity-manager';
import { ApiKeyRepository } from '../api-key.repository';

describe('ApiKeyRepository environment management', () => {
	const defaultManager = mockEntityManager(ApiKey);
	const transactionManager = mock<EntityManager>();
	const repository = new ApiKeyRepository(defaultManager.connection, mock<TransactionRunner>());
	const ctx = { trx: new TypeOrmTransaction(transactionManager) };
	const key = mock<ApiKey>({ id: 'managed-key', userId: 'owner-1' });

	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('uses the transaction manager for each reconciliation lookup', async () => {
		transactionManager.findOne.mockResolvedValue(key);

		await expect(repository.findEnvManaged(ctx)).resolves.toBe(key);
		await expect(repository.findByValue('key-value', ctx)).resolves.toBe(key);
		await expect(repository.findByOwnerAndLabel('owner-1', 'label', ctx)).resolves.toBe(key);

		expect(transactionManager.findOne.mock.calls).toEqual([
			[ApiKey, { where: { managedByEnv: true, audience: 'public-api' } }],
			[ApiKey, { where: { apiKey: 'key-value' } }],
			[ApiKey, { where: { userId: 'owner-1', label: 'label' } }],
		]);
		expect(defaultManager.findOne).not.toHaveBeenCalled();
	});

	it('inserts and updates only through the active transaction', async () => {
		const data = {
			userId: 'owner-1',
			apiKey: 'key-value',
			label: 'label',
			scopes: [],
			audience: 'public-api' as const,
		};
		transactionManager.create.mockImplementation(() => key as never);
		transactionManager.save.mockResolvedValue(key);

		await expect(repository.insertEnvManaged(data, ctx)).resolves.toBe(key);
		const changes = { apiKey: 'rotated-value', lastUsedAt: null };
		await repository.updateEnvManaged(key.id, changes, ctx);

		expect(transactionManager.create).toHaveBeenCalledWith(ApiKey, {
			...data,
			managedByEnv: true,
			lastUsedAt: null,
		});
		expect(transactionManager.save).toHaveBeenCalledWith(ApiKey, key);
		expect(transactionManager.update).toHaveBeenCalledWith(
			ApiKey,
			{ id: key.id, managedByEnv: true },
			changes,
		);
		expect(defaultManager.save).not.toHaveBeenCalled();
		expect(defaultManager.update).not.toHaveBeenCalled();
	});

	it('selects and deletes managed keys within the same transaction', async () => {
		transactionManager.find.mockResolvedValue([key]);

		await expect(repository.deleteEnvManaged(ctx)).resolves.toEqual([key]);

		expect(transactionManager.find).toHaveBeenCalledWith(ApiKey, { where: { managedByEnv: true } });
		expect(transactionManager.delete).toHaveBeenCalledWith(ApiKey, { id: In([key.id]) });
		expect(defaultManager.find).not.toHaveBeenCalled();
		expect(defaultManager.delete).not.toHaveBeenCalled();
	});
});
