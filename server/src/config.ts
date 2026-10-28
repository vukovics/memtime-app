const DEFAULT_PORT = 3000;
const DEFAULT_UPSTREAM_BASE_URL =
  "https://interview-api.memtime-demo.deno.net/api/v1";

export interface Config {
  apiKey: string;
  port: number;
  upstreamBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.API_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable API_KEY");
  }

  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT !== "") {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid PORT "${env.PORT}": must be an integer between 1 and 65535`,
      );
    }
  }

  const upstreamBaseUrl = env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL;

  return { apiKey, port, upstreamBaseUrl };
}
