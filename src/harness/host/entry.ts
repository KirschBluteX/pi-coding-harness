import { HostIpcServer } from "./server.js";
import { CodingHarnessHostRuntime } from "./runtime.js";
import { createProductionDynamicMultiHostPortsFactory } from "./production-dynamic-multi.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

const secretHex = requiredEnvironment("PCH_HOST_SECRET");
delete process.env.PCH_HOST_SECRET;
if (!/^[a-f0-9]{64}$/u.test(secretHex)) throw new TypeError("PCH_HOST_SECRET is invalid");
const secret = Buffer.from(secretHex, "hex");
const runtime = new CodingHarnessHostRuntime({
  packageRoot: requiredEnvironment("PCH_PACKAGE_ROOT"),
  configPath: requiredEnvironment("PCH_CONFIG_PATH"),
  hostSecret: secret,
  dynamicMulti: createProductionDynamicMultiHostPortsFactory(),
  ...(process.env.PCH_DATA_ROOT === undefined ? {} : { dataRoot: process.env.PCH_DATA_ROOT }),
});
const server = new HostIpcServer(secret, (method, params) => runtime.dispatch(method, params), {
  onProtocolError: (error) => process.stderr.write(`PCH_IPC_ERROR ${error.message}\n`),
});
const stop = server.serve(process.stdin, process.stdout);

function shutdown(): void {
  stop();
  runtime.close();
  secret.fill(0);
}

process.once("SIGINT", () => { shutdown(); process.exitCode = 130; });
process.once("SIGTERM", () => { shutdown(); process.exitCode = 143; });
process.stdin.once("end", shutdown);
