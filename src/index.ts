import { loadConfig } from "./config.js";
import { GlitchTopTraderService } from "./service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new GlitchTopTraderService(config);
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`Received ${signal}; shutting down Glitch TopTrader.`);
    await service.stop();
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await service.start();
  console.log(
    `Glitch TopTrader is listening on http://${config.localGateway.host}:${config.localGateway.port} in ${config.tradingMode} mode.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
