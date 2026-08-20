import { buildApp } from "./app.js";

const port = Number(process.env.MOCK_ERP_PORT ?? 3620);
const host = process.env.MOCK_ERP_HOST ?? "0.0.0.0";

const { app, store } = buildApp({ logger: true });

app
  .listen({ port, host })
  .then(() => {
    app.log.info(
      {
        entities: store.tables.size,
        queryOps: store.queryOps.size,
        writeOps: store.writeOps.size,
        dataDir: store.dataDir,
        journal: store.journalPath,
      },
      `mock Meta ERP listening on :${port}`,
    );
  })
  .catch((err) => {
    app.log.error(err, "mock Meta ERP failed to start");
    process.exit(1);
  });
