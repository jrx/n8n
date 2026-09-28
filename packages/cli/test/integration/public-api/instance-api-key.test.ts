import { testDb } from '@n8n/backend-test-utils';
import { DatabaseConfig, InstanceSettingsLoaderConfig } from '@n8n/config';
import { ApiKeyRepository, type User, UserRepository } from '@n8n/db';
import { Container } from '@n8n/di';

import { InstanceApiKeyInstanceSettingsLoader } from '@/instance-settings-loader/loaders/instance-api-key.instance-settings-loader';
import { addApiKey, createOwner } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

const initialKey = `n8n_api_${'a'.repeat(64)}`;
const rotatedKey = `n8n_api_${'b'.repeat(64)}`;

describe('Environment-managed instance API key', () => {
	beforeAll(() => {
		// A single connection would serialize callers without exercising the advisory lock.
		Container.get(DatabaseConfig).postgresdb.poolSize = 3;
	});

	const server = setupTestServer({ endpointGroups: ['publicApi', 'apiKeys'] });
	let owner: User;
	let repository: ApiKeyRepository;
	let config: InstanceSettingsLoaderConfig;
	let loader: InstanceApiKeyInstanceSettingsLoader;

	beforeAll(async () => {
		await testDb.truncate(['User']);
		owner = await createOwner();
		repository = Container.get(ApiKeyRepository);
		config = Container.get(InstanceSettingsLoaderConfig);
		loader = Container.get(InstanceApiKeyInstanceSettingsLoader);
	});

	beforeEach(async () => {
		await testDb.truncate(['ApiKey']);
		config.ownerManagedByEnv = true;
		config.instanceApiKeyManagedByEnv = true;
		config.instanceApiKey = initialKey;
		config.instanceApiKeyScopes = '';
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('authenticates after creation, rotates in place, and revokes only the managed key', async () => {
		const userKey = await addApiKey(owner);
		await loader.run();
		const created = await repository.findOneByOrFail({ managedByEnv: true });
		expect(created).toMatchObject({ userId: owner.id, audience: 'public-api' });
		await server.publicApiAgentWithApiKey(initialKey).get('/workflows').expect(200);

		await expect(loader.run()).resolves.toBe('skipped');
		expect(await repository.countBy({ managedByEnv: true })).toBe(1);
		expect((await repository.findOneByOrFail({ managedByEnv: true })).id).toBe(created.id);

		await repository.update(created.id, { lastUsedAt: new Date('2025-01-02T03:04:05Z') });
		config.instanceApiKey = rotatedKey;
		await loader.run();
		expect(await repository.findOneByOrFail({ managedByEnv: true })).toMatchObject({
			id: created.id,
			apiKey: rotatedKey,
			lastUsedAt: null,
		});
		await server.publicApiAgentWithApiKey(initialKey).get('/workflows').expect(401);
		await server.publicApiAgentWithApiKey(rotatedKey).get('/workflows').expect(200);

		config.instanceApiKeyManagedByEnv = false;
		config.instanceApiKey = 'ignored when disabled';
		config.instanceApiKeyScopes = 'unknown:scope';
		await loader.run();
		expect(await repository.countBy({ managedByEnv: true })).toBe(0);
		await server.publicApiAgentWithApiKey(rotatedKey).get('/workflows').expect(401);
		await server.publicApiAgentWithApiKey(userKey.apiKey).get('/workflows').expect(200);
	});

	it('enforces licensed scopes and restores owner scopes when the license is removed', async () => {
		server.license.enable('feat:apiKeyScopes');
		config.instanceApiKeyScopes = 'workflow:read,workflow:list';
		await loader.run();
		expect((await repository.findOneByOrFail({ managedByEnv: true })).scopes).toEqual([
			'workflow:read',
			'workflow:list',
		]);
		const agent = server.publicApiAgentWithApiKey(initialKey);
		await agent.get('/workflows').expect(200);
		const workflow = { name: 'Scope check', nodes: [], connections: {}, settings: {} };
		await agent.post('/workflows').send(workflow).expect(403);

		server.license.disable('feat:apiKeyScopes');
		await loader.run();
		await agent.post('/workflows').send(workflow).expect(200);
	});

	it('keeps the existing key when rotation conflicts with a user key', async () => {
		await loader.run();
		const original = await repository.findOneByOrFail({ managedByEnv: true });
		const userKey = await addApiKey(owner);
		await repository.update(userKey.id, { apiKey: rotatedKey });
		config.instanceApiKey = rotatedKey;

		await expect(loader.run()).rejects.toThrow('already used by an API key');
		expect(await repository.findOneByOrFail({ id: original.id })).toEqual(original);
		await server.publicApiAgentWithApiKey(initialKey).get('/workflows').expect(200);
		await server.publicApiAgentWithApiKey(rotatedKey).get('/workflows').expect(200);
	});

	it('rolls back deletion when reconciliation fails after the write', async () => {
		await loader.run();
		const original = await repository.findOneByOrFail({ managedByEnv: true });
		config.instanceApiKeyManagedByEnv = false;
		vi.spyOn(Container.get(UserRepository), 'findInstanceOwner').mockResolvedValueOnce(null);

		await expect(loader.run()).rejects.toThrow('instance owner does not exist');
		expect(await repository.findOneByOrFail({ id: original.id })).toEqual(original);
		await server.publicApiAgentWithApiKey(initialKey).get('/workflows').expect(200);
	});

	it('returns the managed marker without exposing either key value', async () => {
		const userKey = await addApiKey(owner);
		await loader.run();
		const response = await server.authAgentFor(owner).get('/api-keys').expect(200);
		expect(response.body.data.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ managedByEnv: true, apiKey: '******aaaa', expiresAt: null }),
				expect.objectContaining({ id: userKey.id, managedByEnv: false }),
			]),
		);
		expect(JSON.stringify(response.body)).not.toContain(initialKey);
		expect(JSON.stringify(response.body)).not.toContain(userKey.apiKey);
	});

	it('authenticates a manually inserted opaque key without environment management', async () => {
		await repository.save(
			repository.create({
				userId: owner.id,
				label: 'Opaque key',
				apiKey: initialKey,
				audience: 'public-api',
				scopes: ['workflow:list'],
			}),
		);
		await server.publicApiAgentWithApiKey(initialKey).get('/workflows').expect(200);
	});

	it('serializes three concurrent reconciliations', async () => {
		const results = await Promise.all([loader.run(), loader.run(), loader.run()]);
		expect(results.sort()).toEqual(['created', 'skipped', 'skipped']);
		expect(await repository.countBy({ managedByEnv: true })).toBe(1);
		await server.publicApiAgentWithApiKey(initialKey).get('/workflows').expect(200);
	});
});
