import { mkdirSync } from "node:fs";
import { createApp } from "./app.js";
import { createCache } from "./cache.js";
import { loadConfig, type Config } from "./config.js";
import { createRateLimitQueue } from "./rateLimitQueue.js";
import { createUpstreamClient } from "./upstream/client.js";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

mkdirSync("data", { recursive: true });

const app = createApp({
  upstream: createUpstreamClient({
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.apiKey,
  }),
  queue: createRateLimitQueue(),
  cache: createCache({ dbPath: "data/cache.sqlite" }),
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
