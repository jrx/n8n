import type { MigrationContext, ReversibleMigration } from '../migration-types';

export class AddManagedByEnvToApiKeys1790359001086 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns(
			'user_api_keys',
			[
				column('managedByEnv')
					.bool.notNull.default(false)
					.comment('Identifies the instance API key managed through environment variables'),
			],
			{ recreatesOnSqlite: true },
		);
	}

	async down({ runQuery, escape, schemaBuilder: { dropColumns } }: MigrationContext) {
		const table = escape.tableName('user_api_keys');
		const managedByEnv = escape.columnName('managedByEnv');

		await runQuery(`DELETE FROM ${table} WHERE ${managedByEnv} = :managedByEnv`, {
			managedByEnv: true,
		});
		await dropColumns('user_api_keys', ['managedByEnv'], { recreatesOnSqlite: true });
	}
}
