import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
	undoLastSingleMigration,
	type TestMigrationContext,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

const MIGRATION_NAME = 'AddManagedByEnvToApiKeys1790359001086';

describe('AddManagedByEnvToApiKeys migration', () => {
	let dataSource: DataSource;

	async function withContext<T>(fn: (context: TestMigrationContext) => Promise<T>): Promise<T> {
		const context = createTestMigrationContext(dataSource);
		try {
			return await fn(context);
		} finally {
			await context.queryRunner.release();
		}
	}

	beforeAll(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.init();
		dataSource = Container.get(DataSource);
	});

	beforeEach(async () => {
		await withContext(async (context) => await context.queryRunner.clearDatabase());
		await initDbUpToMigration(MIGRATION_NAME);
	});

	afterAll(async () => {
		await Container.get(DbConnection).close();
	});

	it('removes managed keys on rollback and preserves user keys across reapplication', async () => {
		const ownerId = randomUUID();
		const managedKeyId = randomUUID();
		const userKeyId = randomUUID();

		await withContext(async (context) => {
			const userTable = context.escape.tableName('user');
			const now = new Date();
			await context.runQuery(
				`INSERT INTO ${userTable} ("id", "email", "firstName", "lastName", "password", "roleSlug", "createdAt", "updatedAt")
				 VALUES (:id, :email, :firstName, :lastName, :password, :roleSlug, :createdAt, :updatedAt)`,
				{
					id: ownerId,
					email: 'owner@example.com',
					firstName: 'Instance',
					lastName: 'Owner',
					password: 'password',
					roleSlug: 'global:owner',
					createdAt: now,
					updatedAt: now,
				},
			);
		});

		await runSingleMigration(MIGRATION_NAME);
		dataSource = Container.get(DataSource);

		await withContext(async (context) => {
			const table = context.escape.tableName('user_api_keys');
			const now = new Date();
			const insertKey = async (
				id: string,
				label: string,
				apiKey: string,
				managedByEnv: boolean,
			) => {
				await context.runQuery(
					`INSERT INTO ${table} ("id", "userId", "label", "apiKey", "scopes", "audience", "managedByEnv", "createdAt", "updatedAt")
					 VALUES (:id, :userId, :label, :apiKey, :scopes, :audience, :managedByEnv, :createdAt, :updatedAt)`,
					{
						id,
						userId: ownerId,
						label,
						apiKey,
						scopes: '[]',
						audience: 'public-api',
						managedByEnv,
						createdAt: now,
						updatedAt: now,
					},
				);
			};

			await insertKey(managedKeyId, 'Managed key', 'managed-key', true);
			await insertKey(userKeyId, 'User key', 'user-key', false);
		});

		await undoLastSingleMigration();
		dataSource = Container.get(DataSource);

		await withContext(async (context) => {
			const table = context.escape.tableName('user_api_keys');
			const rows = await context.runQuery<Array<{ id: string }>>(
				`SELECT "id" FROM ${table} ORDER BY "id"`,
			);
			expect(rows).toEqual([{ id: userKeyId }]);
		});

		await runSingleMigration(MIGRATION_NAME);
		dataSource = Container.get(DataSource);

		await withContext(async (context) => {
			const table = context.escape.tableName('user_api_keys');
			const rows = await context.runQuery<Array<{ id: string; managedByEnv: boolean | number }>>(
				`SELECT "id", "managedByEnv" FROM ${table}`,
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].id).toBe(userKeyId);
			expect(Boolean(rows[0].managedByEnv)).toBe(false);
		});
	});
});
