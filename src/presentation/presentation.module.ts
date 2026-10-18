import { Module } from "@nestjs/common";
import { HealthController } from "./controllers/health.controller.ts";
import { MetricsController } from "./controllers/metrics.controller.ts";
import { WageringController } from "./controllers/wagering.controller.ts";
import { WalletController } from "./controllers/wallet.controller.ts";
import { MetricsService } from "./metrics/metrics.service.ts";

@Module({
  controllers: [WalletController, WageringController, HealthController, MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class PresentationModule {}
