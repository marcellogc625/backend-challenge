import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GlobalHttpExceptionFilter } from "@presentation/filters/http-exception.filter.ts";
import { CorrelationIdInterceptor } from "@presentation/interceptors/correlation-id.interceptor.ts";
import { AppModule } from "./app.module.ts";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new GlobalHttpExceptionFilter());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Server running on port ${port}`);
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
