import { LicenseState, Logger } from '@n8n/backend-common';
import { GlobalConfig, InstanceSettingsLoaderConfig } from '@n8n/config';
import { ApiKeyRepository, DbLock, DbLockService, type User, UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import type { ApiKeyScope } from '@n8n/permissions';
import { getApiKeyScopesForRole } from '@n8n/permissions';
import { z } from 'zod';

import { EventService } from '@/events/event.service';
import { PublicApiKeyService } from '@/services/public-api-key.service';

import { InstanceBootstrappingError } from '../instance-bootstrapping.error';

const ENV_MANAGED_API_KEY_LABEL = 'Owner API key';
const ENV_MANAGED_API_KEY_FORMAT = /^n8n_api_[A-Za-z0-9]{64,248}$/;

const instanceApiKeyEnvSchema = z
	.object({
		ownerManagedByEnv: z.literal(true, {
			errorMap: () => ({
				message:
					'N8N_INSTANCE_OWNER_MANAGED_BY_ENV must be true when N8N_INSTANCE_API_KEY_MANAGED_BY_ENV is true',
			}),
		}),
		instanceApiKey: z
			.string()
			.regex(
				ENV_MANAGED_API_KEY_FORMAT,
				'N8N_INSTANCE_API_KEY must be n8n_api_ followed by 64 to 248 letters or digits',
			),
		instanceApiKeyScopes: z.string(),
	})
	.transform(({ instanceApiKey, instanceApiKeyScopes }) => ({
		apiKey: instanceApiKey,
		scopes: [
			...new Set(
				instanceApiKeyScopes
					.split(',')
					.map((scope) => scope.trim())
					.filter(Boolean),
			),
		],
	}));

type PendingEvent =
	| { type: 'created'; user: User }
	| { type: 'rotated'; user: User }
	| { type: 'deleted'; user: User };

@Service()
export class InstanceApiKeyInstanceSettingsLoader {
	private readonly pendingEvents: PendingEvent[] = [];

	constructor(
		private readonly config: InstanceSettingsLoaderConfig,
		private readonly globalConfig: GlobalConfig,
		private readonly licenseState: LicenseState,
		private readonly apiKeyRepository: ApiKeyRepository,
		private readonly userRepository: UserRepository,
		private readonly dbLockService: DbLockService,
		private readonly publicApiKeyService: PublicApiKeyService,
		private readonly eventService: EventService,
		private logger: Logger,
	) {
		this.logger = this.logger.scoped('instance-settings-loader');
		this.eventService.once('server-started', () => this.emitPendingEvents());
	}

	async run(): Promise<'created' | 'skipped'> {
		if (!this.config.instanceApiKeyManagedByEnv) {
			return await this.revoke();
		}

		const parsed = instanceApiKeyEnvSchema.safeParse(this.config);
		if (!parsed.success) {
			throw new InstanceBootstrappingError(parsed.error.issues[0].message);
		}

		if (this.globalConfig.publicApi.disabled) {
			this.logger.warn(
				'N8N_INSTANCE_API_KEY is configured, but the Public API is disabled. The key cannot be used until the Public API is enabled.',
			);
		}

		const event = await this.dbLockService.withLockContext(
			DbLock.INSTANCE_API_KEY_RECONCILE,
			async (ctx): Promise<PendingEvent | 'scope-updated' | null> => {
				const owner = await this.userRepository.findInstanceOwner(ctx);
				if (!owner) {
					throw new InstanceBootstrappingError(
						'The instance owner does not exist after N8N_INSTANCE_OWNER_MANAGED_BY_ENV was applied',
					);
				}
				const scopes = this.resolveScopes(owner, parsed.data.scopes);

				const existing = await this.apiKeyRepository.findEnvManaged(ctx);
				const valueCollision = await this.apiKeyRepository.findByValue(parsed.data.apiKey, ctx);
				if (valueCollision && !valueCollision.managedByEnv) {
					throw new InstanceBootstrappingError(
						'N8N_INSTANCE_API_KEY is already used by an API key that is not managed by environment variables',
					);
				}

				if (!existing) {
					const labelCollision = await this.apiKeyRepository.findByOwnerAndLabel(
						owner.id,
						ENV_MANAGED_API_KEY_LABEL,
						ctx,
					);
					if (labelCollision) {
						throw new InstanceBootstrappingError(
							`The instance owner already has an API key with the label "${ENV_MANAGED_API_KEY_LABEL}"`,
						);
					}

					await this.apiKeyRepository.insertEnvManaged(
						{
							userId: owner.id,
							apiKey: parsed.data.apiKey,
							label: ENV_MANAGED_API_KEY_LABEL,
							scopes,
							audience: 'public-api',
						},
						ctx,
					);
					this.logger.info('Created the env-managed instance API key');
					return { type: 'created', user: owner };
				}

				const valueChanged = existing.apiKey !== parsed.data.apiKey;
				const scopesChanged = !this.scopesEqual(existing.scopes, scopes);
				if (!valueChanged && !scopesChanged) return null;

				await this.apiKeyRepository.updateEnvManaged(
					existing.id,
					{
						...(valueChanged ? { apiKey: parsed.data.apiKey, lastUsedAt: null } : {}),
						...(scopesChanged ? { scopes } : {}),
					},
					ctx,
				);

				if (valueChanged) {
					this.logger.info('Rotated the env-managed instance API key');
					return { type: 'rotated', user: owner };
				}

				this.logger.info('Updated scopes for the env-managed instance API key');
				return 'scope-updated';
			},
		);

		if (event && event !== 'scope-updated') this.pendingEvents.push(event);
		return event ? 'created' : 'skipped';
	}

	private async revoke(): Promise<'created' | 'skipped'> {
		const events = await this.dbLockService.withLockContext(
			DbLock.INSTANCE_API_KEY_RECONCILE,
			async (ctx): Promise<PendingEvent[]> => {
				const apiKeys = await this.apiKeyRepository.deleteEnvManaged(ctx);
				if (apiKeys.length === 0) return [];

				const owner = await this.userRepository.findInstanceOwner(ctx);
				if (!owner) {
					throw new InstanceBootstrappingError(
						'Cannot revoke the env-managed instance API key because the instance owner does not exist',
					);
				}

				this.logger.info('Deleted the env-managed instance API key');
				return apiKeys.map(() => ({ type: 'deleted', user: owner }));
			},
		);

		this.pendingEvents.push(...events);
		return events.length > 0 ? 'created' : 'skipped';
	}

	private resolveScopes(owner: User, configuredScopes: string[]): ApiKeyScope[] {
		const allOwnerScopes = getApiKeyScopesForRole(owner);

		if (configuredScopes.length === 0) return allOwnerScopes;

		if (!this.licenseState.isApiKeyScopesLicensed()) {
			this.logger.warn(
				'N8N_INSTANCE_API_KEY_SCOPES is ignored because API key scopes are not licensed. The key has full owner access.',
			);
			return allOwnerScopes;
		}

		const resolvedScopes: ApiKeyScope[] = [];
		for (const scope of configuredScopes) {
			const ownerScope = allOwnerScopes.find((candidate) => candidate === scope);
			if (
				ownerScope === undefined ||
				!this.publicApiKeyService.apiKeyHasValidScopesForRole(owner, [ownerScope])
			) {
				throw new InstanceBootstrappingError(
					`N8N_INSTANCE_API_KEY_SCOPES contains a scope that the owner cannot grant: ${scope}`,
				);
			}
			resolvedScopes.push(ownerScope);
		}

		return resolvedScopes;
	}

	private scopesEqual(left: ApiKeyScope[], right: ApiKeyScope[]): boolean {
		return left.length === right.length && left.every((scope, index) => scope === right[index]);
	}

	private emitPendingEvents() {
		for (const event of this.pendingEvents.splice(0)) {
			if (event.type === 'created') {
				this.eventService.emit('public-api-key-created', {
					user: event.user,
					publicApi: false,
					managedByEnv: true,
				});
			} else if (event.type === 'rotated') {
				this.eventService.emit('public-api-key-rotated', {
					user: event.user,
					publicApi: false,
					managedByEnv: true,
				});
			} else {
				this.eventService.emit('public-api-key-deleted', {
					user: event.user,
					publicApi: false,
					managedByEnv: true,
					isOwn: true,
				});
			}
		}
	}
}
