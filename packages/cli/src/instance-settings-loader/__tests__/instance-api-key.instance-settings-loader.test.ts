import type { LicenseState, Logger } from '@n8n/backend-common';
import type { GlobalConfig, InstanceSettingsLoaderConfig } from '@n8n/config';
import type { ApiKey, ApiKeyRepository, DbLockService, User, UserRepository } from '@n8n/db';
import { DbLock } from '@n8n/db';
import { getApiKeyScopesForRole } from '@n8n/permissions';
import { mock } from 'vitest-mock-extended';

import { EventService } from '@/events/event.service';
import type { PublicApiKeyService } from '@/services/public-api-key.service';

import { InstanceBootstrappingError } from '../instance-bootstrapping.error';
import { InstanceApiKeyInstanceSettingsLoader } from '../loaders/instance-api-key.instance-settings-loader';

vi.mock('@n8n/permissions', async () => ({
	...(await vi.importActual<typeof import('@n8n/permissions')>('@n8n/permissions')),
	getApiKeyScopesForRole: vi.fn(),
}));

const VALID_API_KEY = `n8n_api_${'a'.repeat(64)}`;
const ROTATED_API_KEY = `n8n_api_${'b'.repeat(64)}`;
const OWNER_SCOPES = ['workflow:read', 'workflow:list', 'workflow:create'] as const;

describe('InstanceApiKeyInstanceSettingsLoader', () => {
	const logger = mock<Logger>({ scoped: vi.fn().mockReturnThis() });
	const licenseState = mock<LicenseState>();
	const apiKeyRepository = mock<ApiKeyRepository>();
	const userRepository = mock<UserRepository>();
	const dbLockService = mock<DbLockService>();
	const publicApiKeyService = mock<PublicApiKeyService>();
	const owner = mock<User>({ id: 'owner-1' });
	const getApiKeyScopesForRoleMock = vi.mocked(getApiKeyScopesForRole);

	const createLoader = (
		configOverrides: Partial<InstanceSettingsLoaderConfig> = {},
		publicApiDisabled = false,
	) => {
		const config = {
			ownerManagedByEnv: true,
			instanceApiKeyManagedByEnv: true,
			instanceApiKey: VALID_API_KEY,
			instanceApiKeyScopes: '',
			...configOverrides,
		} as InstanceSettingsLoaderConfig;
		const globalConfig = {
			publicApi: { disabled: publicApiDisabled },
		} as GlobalConfig;
		const eventService = new EventService();
		const loader = new InstanceApiKeyInstanceSettingsLoader(
			config,
			globalConfig,
			licenseState,
			apiKeyRepository,
			userRepository,
			dbLockService,
			publicApiKeyService,
			eventService,
			logger,
		);

		return { loader, eventService };
	};

	beforeEach(() => {
		vi.resetAllMocks();
		logger.scoped.mockReturnThis();
		licenseState.isApiKeyScopesLicensed.mockReturnValue(true);
		getApiKeyScopesForRoleMock.mockReturnValue([...OWNER_SCOPES]);
		publicApiKeyService.apiKeyHasValidScopesForRole.mockReturnValue(true);
		userRepository.findInstanceOwner.mockResolvedValue(owner);
		apiKeyRepository.findEnvManaged.mockResolvedValue(null);
		apiKeyRepository.findByValue.mockResolvedValue(null);
		apiKeyRepository.findByOwnerAndLabel.mockResolvedValue(null);
		apiKeyRepository.deleteEnvManaged.mockResolvedValue([]);
		dbLockService.withLockContext.mockImplementation(async (_lockId, fn) => await fn({}));
	});

	it('requires environment-managed owner settings', async () => {
		const { loader } = createLoader({ ownerManagedByEnv: false });

		await expect(loader.run()).rejects.toThrow('N8N_INSTANCE_OWNER_MANAGED_BY_ENV must be true');
		expect(dbLockService.withLockContext).not.toHaveBeenCalled();
	});

	it.each([
		['an empty key', ''],
		['a key that is too short', `n8n_api_${'a'.repeat(63)}`],
		['a key that is too long', `n8n_api_${'a'.repeat(249)}`],
		['a key with the wrong prefix', `api_${'a'.repeat(64)}`],
		['a key with punctuation', `n8n_api_${'a'.repeat(63)}-`],
	])('rejects %s without exposing its value', async (_description, invalidApiKey) => {
		const { loader } = createLoader({ instanceApiKey: invalidApiKey });

		let error: unknown;
		try {
			await loader.run();
		} catch (cause) {
			error = cause;
		}

		expect(error).toBeInstanceOf(InstanceBootstrappingError);
		expect((error as Error).message).toContain('N8N_INSTANCE_API_KEY');
		if (invalidApiKey) expect((error as Error).message).not.toContain(invalidApiKey);
		expect(logger.error).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expect(logger.info).not.toHaveBeenCalled();
	});

	it.each([64, 248])('accepts a key with %i suffix characters', async (length) => {
		const { loader } = createLoader({ instanceApiKey: `n8n_api_${'A0'.repeat(length / 2)}` });
		await expect(loader.run()).resolves.toBe('created');
	});

	it.each(['', ' , , '])(
		'grants all owner scopes when the configured scopes are %j',
		async (scopes) => {
			const { loader } = createLoader({ instanceApiKeyScopes: scopes });

			await expect(loader.run()).resolves.toBe('created');

			expect(apiKeyRepository.insertEnvManaged).toHaveBeenCalledWith(
				expect.objectContaining({ scopes: [...OWNER_SCOPES] }),
				{},
			);
		},
	);

	it('trims and deduplicates licensed scopes', async () => {
		const { loader } = createLoader({
			instanceApiKeyScopes: ' workflow:list,workflow:read, workflow:list ',
		});

		await loader.run();

		expect(apiKeyRepository.insertEnvManaged).toHaveBeenCalledWith(
			expect.objectContaining({ scopes: ['workflow:list', 'workflow:read'] }),
			{},
		);
	});

	it('rejects a scope that the owner cannot grant', async () => {
		const { loader } = createLoader({ instanceApiKeyScopes: 'workflow:read,unknown:scope' });

		await expect(loader.run()).rejects.toThrow(
			'N8N_INSTANCE_API_KEY_SCOPES contains a scope that the owner cannot grant: unknown:scope',
		);
		expect(apiKeyRepository.insertEnvManaged).not.toHaveBeenCalled();
	});

	it('uses all owner scopes when API key scopes are not licensed', async () => {
		licenseState.isApiKeyScopesLicensed.mockReturnValue(false);
		const { loader } = createLoader({ instanceApiKeyScopes: 'workflow:read' });

		await loader.run();

		expect(apiKeyRepository.insertEnvManaged).toHaveBeenCalledWith(
			expect.objectContaining({ scopes: [...OWNER_SCOPES] }),
			{},
		);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is ignored'));
	});

	it('creates the key inside the reconciliation lock', async () => {
		const { loader } = createLoader();

		await expect(loader.run()).resolves.toBe('created');

		expect(dbLockService.withLockContext).toHaveBeenCalledWith(
			DbLock.INSTANCE_API_KEY_RECONCILE,
			expect.any(Function),
		);
		expect(apiKeyRepository.insertEnvManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: owner.id,
				apiKey: VALID_API_KEY,
				label: 'Owner API key',
				audience: 'public-api',
			}),
			{},
		);
	});

	it('does nothing when the value and scopes already match', async () => {
		apiKeyRepository.findEnvManaged.mockResolvedValue(
			mock<ApiKey>({ apiKey: VALID_API_KEY, scopes: [...OWNER_SCOPES] }),
		);
		const { loader } = createLoader();

		await expect(loader.run()).resolves.toBe('skipped');

		expect(apiKeyRepository.updateEnvManaged).not.toHaveBeenCalled();
	});

	it('rotates the existing key in place and resets lastUsedAt', async () => {
		apiKeyRepository.findEnvManaged.mockResolvedValue(
			mock<ApiKey>({ id: 'key-1', apiKey: VALID_API_KEY, scopes: [...OWNER_SCOPES] }),
		);
		const { loader } = createLoader({ instanceApiKey: ROTATED_API_KEY });

		await expect(loader.run()).resolves.toBe('created');

		expect(apiKeyRepository.updateEnvManaged).toHaveBeenCalledWith(
			'key-1',
			{ apiKey: ROTATED_API_KEY, lastUsedAt: null },
			{},
		);
	});

	it('updates scopes without resetting lastUsedAt', async () => {
		apiKeyRepository.findEnvManaged.mockResolvedValue(
			mock<ApiKey>({ id: 'key-1', apiKey: VALID_API_KEY, scopes: ['workflow:read'] }),
		);
		const { loader } = createLoader({ instanceApiKeyScopes: 'workflow:list' });

		await expect(loader.run()).resolves.toBe('created');

		expect(apiKeyRepository.updateEnvManaged).toHaveBeenCalledWith(
			'key-1',
			{ scopes: ['workflow:list'] },
			{},
		);
	});

	it('revokes every marked key when environment management is off', async () => {
		apiKeyRepository.deleteEnvManaged.mockResolvedValue([
			mock<ApiKey>({ id: 'key-1' }),
			mock<ApiKey>({ id: 'key-2' }),
		]);
		const { loader } = createLoader({ instanceApiKeyManagedByEnv: false });

		await expect(loader.run()).resolves.toBe('created');

		expect(apiKeyRepository.deleteEnvManaged).toHaveBeenCalledWith({});
	});

	it('fails before writing when the value belongs to an unmanaged key', async () => {
		apiKeyRepository.findEnvManaged.mockResolvedValue(
			mock<ApiKey>({ id: 'key-1', apiKey: VALID_API_KEY, scopes: [...OWNER_SCOPES] }),
		);
		apiKeyRepository.findByValue.mockResolvedValue(mock<ApiKey>({ managedByEnv: false }));
		const { loader } = createLoader({ instanceApiKey: ROTATED_API_KEY });

		await expect(loader.run()).rejects.toThrow('already used by an API key');
		expect(apiKeyRepository.updateEnvManaged).not.toHaveBeenCalled();
	});

	it('fails before inserting when the reserved label is already used', async () => {
		apiKeyRepository.findByOwnerAndLabel.mockResolvedValue(mock<ApiKey>());
		const { loader } = createLoader();

		await expect(loader.run()).rejects.toThrow('already has an API key with the label');
		expect(apiKeyRepository.findByOwnerAndLabel).toHaveBeenCalledWith(
			owner.id,
			'Owner API key',
			{},
		);
		expect(apiKeyRepository.insertEnvManaged).not.toHaveBeenCalled();
	});

	it('warns when the Public API is disabled but still reconciles the key', async () => {
		const { loader } = createLoader({}, true);

		await expect(loader.run()).resolves.toBe('created');

		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Public API is disabled'));
		expect(apiKeyRepository.insertEnvManaged).toHaveBeenCalled();
	});

	it('defers the created event until the server has started', async () => {
		const { loader, eventService } = createLoader();
		const listener = vi.fn();
		eventService.on('public-api-key-created', listener);

		await loader.run();

		expect(listener).not.toHaveBeenCalled();
		eventService.emit('server-started');
		expect(listener).toHaveBeenCalledWith({
			user: owner,
			publicApi: false,
			managedByEnv: true,
		});
		eventService.emit('server-started');
		expect(listener).toHaveBeenCalledOnce();
	});

	it.each(['no-op', 'scope-only'])(
		'emits no audit event for a %s reconciliation',
		async (change) => {
			apiKeyRepository.findEnvManaged.mockResolvedValue(
				mock<ApiKey>({
					id: 'key-1',
					apiKey: VALID_API_KEY,
					scopes: change === 'no-op' ? [...OWNER_SCOPES] : ['workflow:read'],
				}),
			);
			const { loader, eventService } = createLoader();
			const listener = vi.fn();
			eventService.on('public-api-key-created', listener);
			eventService.on('public-api-key-rotated', listener);
			eventService.on('public-api-key-deleted', listener);

			await loader.run();
			eventService.emit('server-started');
			expect(listener).not.toHaveBeenCalled();
		},
	);

	it('emits rotation but no event for a later scope-only update', async () => {
		apiKeyRepository.findEnvManaged
			.mockResolvedValueOnce(
				mock<ApiKey>({ id: 'key-1', apiKey: VALID_API_KEY, scopes: [...OWNER_SCOPES] }),
			)
			.mockResolvedValueOnce(
				mock<ApiKey>({ id: 'key-1', apiKey: ROTATED_API_KEY, scopes: ['workflow:read'] }),
			);
		const { loader, eventService } = createLoader({ instanceApiKey: ROTATED_API_KEY });
		const rotatedListener = vi.fn();
		const createdListener = vi.fn();
		eventService.on('public-api-key-rotated', rotatedListener);
		eventService.on('public-api-key-created', createdListener);

		await loader.run();
		await loader.run();
		expect(rotatedListener).not.toHaveBeenCalled();
		eventService.emit('server-started');

		expect(rotatedListener).toHaveBeenCalledOnce();
		expect(rotatedListener).toHaveBeenCalledWith({
			user: owner,
			publicApi: false,
			managedByEnv: true,
		});
		expect(createdListener).not.toHaveBeenCalled();
	});

	it('defers one delete event for each revoked marked key', async () => {
		apiKeyRepository.deleteEnvManaged.mockResolvedValue([
			mock<ApiKey>({ id: 'key-1' }),
			mock<ApiKey>({ id: 'key-2' }),
		]);
		const { loader, eventService } = createLoader({ instanceApiKeyManagedByEnv: false });
		const listener = vi.fn();
		eventService.on('public-api-key-deleted', listener);

		await loader.run();
		expect(listener).not.toHaveBeenCalled();
		eventService.emit('server-started');

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenCalledWith({
			user: owner,
			publicApi: false,
			managedByEnv: true,
			isOwn: true,
		});
	});
});
