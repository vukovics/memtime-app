import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

createApp().listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
