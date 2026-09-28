import { mockInstance, testDb } from '@n8n/backend-test-utils';
import { InstanceSettingsLoaderConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';

import type { EventMessageTypes } from '@/eventbus';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import { EventService } from '@/events/event.service';
import { LogStreamingEventRelay } from '@/events/relays/log-streaming.event-relay';
import { InstanceApiKeyInstanceSettingsLoader } from '@/instance-settings-loader/loaders/instance-api-key.instance-settings-loader';
import { MessageEventBusDestination } from '@/modules/log-streaming.ee/destinations/message-event-bus-destination.ee';
import { LogStreamingDestinationService } from '@/modules/log-streaming.ee/log-streaming-destination.service';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import { createOwner } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

vi.unmock('@/eventbus/message-event-bus/message-event-bus');

mockInstance(Publisher);

setupTestServer({ enabledFeatures: ['feat:logStreaming'], modules: ['log-streaming'] });

class TestLogStreamingDestination extends MessageEventBusDestination {
	readonly received: EventMessageTypes[] = [];

	constructor(eventBus: MessageEventBus) {
		super(eventBus, {
			__type: MessageEventBusDestinationTypeNames.abstract,
			label: 'Instance API key audit test',
			enabled: true,
			subscribedEvents: ['n8n.audit.user.api.created'],
		});
	}

	async receiveFromEventBus({
		msg,
		confirmCallback,
	}: Parameters<MessageEventBusDestination['receiveFromEventBus']>[0]) {
		this.received.push(msg);
		confirmCallback(msg, { id: this.id, name: this.label });
		return true;
	}
}

describe('Environment-managed instance API key log streaming', () => {
	let eventBus: MessageEventBus;
	let destinationService: LogStreamingDestinationService;

	beforeAll(async () => {
		await testDb.init();
		eventBus = Container.get(MessageEventBus);
		await eventBus.initialize();
		destinationService = Container.get(LogStreamingDestinationService);
		await destinationService.initialize();
		Container.get(LogStreamingEventRelay).init();
	});

	afterAll(async () => {
		await destinationService.close();
		await eventBus.close();
	});

	it('delivers the created event only after the server starts', async () => {
		await testDb.truncate(['User']);
		const owner = await createOwner();
		const destination = new TestLogStreamingDestination(eventBus);
		await destinationService.addDestination(destination, false);

		const config = Container.get(InstanceSettingsLoaderConfig);
		config.ownerManagedByEnv = true;
		config.instanceApiKeyManagedByEnv = true;
		config.instanceApiKey = `n8n_api_${'a'.repeat(64)}`;
		config.instanceApiKeyScopes = '';

		await Container.get(InstanceApiKeyInstanceSettingsLoader).run();
		expect(destination.received).toHaveLength(0);

		Container.get(EventService).emit('server-started');

		await vi.waitFor(() => expect(destination.received).toHaveLength(1));
		expect(destination.received[0]).toMatchObject({
			eventName: 'n8n.audit.user.api.created',
			payload: {
				userId: owner.id,
				_email: owner.email,
				_firstName: owner.firstName,
				_lastName: owner.lastName,
				globalRole: owner.role.slug,
				managed_by_env: true,
			},
		});
	});
});
