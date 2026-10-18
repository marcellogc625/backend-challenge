import { Global, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { UNIT_OF_WORK_PORT } from "@application/ports/unit-of-work.port.ts";
import { buildMikroOrmOptions } from "./mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "./repositories/mikro-orm-unit-of-work.ts";

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: async () => MikroORM.init(buildMikroOrmOptions()),
    },
    {
      provide: UNIT_OF_WORK_PORT,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm.em),
    },
  ],
  exports: [MikroORM, UNIT_OF_WORK_PORT],
})
export class PersistenceModule implements OnModuleDestroy {
  constructor(private readonly orm: MikroORM) {}

  async onModuleDestroy(): Promise<void> {
    await this.orm.close(true);
  }
}
