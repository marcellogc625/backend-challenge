import { Module, type OnApplicationBootstrap } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ApplicationModule } from "@application/application.module.ts";
import { OutboxPublisherWorker } from "@infrastructure/messaging/outbox-publisher.worker.ts";
import { PendingReferencesWorker } from "@infrastructure/messaging/pending-references.worker.ts";
import { WagerTransactionsConsumer } from "@infrastructure/messaging/wager-transactions.consumer.ts";
import { PersistenceModule } from "@infrastructure/persistence/persistence.module.ts";
import { PresentationModule } from "@presentation/presentation.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PersistenceModule,
    ApplicationModule,
    PresentationModule,
  ],
  providers: [
    OutboxPublisherWorker,
    WagerTransactionsConsumer,
    PendingReferencesWorker,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  onApplicationBootstrap(): void {
    // Background workers são inicializados via lifecycle hooks do NestJS
  }
}
