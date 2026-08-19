import fs from "node:fs";

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    process.env[line.slice(0, i)] = line.slice(i + 1);
  }
}

const { loadConfig } = await import("../dist/src/config.js");
const { ProjectXApiClient } = await import("../dist/src/projectx/client.js");

const config = loadConfig();
const api = new ProjectXApiClient({
  apiUrl: config.projectX.apiUrl,
  username: config.projectX.username,
  apiKey: config.projectX.apiKey,
});
await api.login();
const orders = await api.searchOpenOrders(config.scope.accountId);
const ours = orders.filter((o) => o.contractId === config.scope.contractId);
for (const order of ours) {
  await api.cancelOrder(config.scope.accountId, order.id);
  console.log("cancelled", order.id, order.customTag);
}
const remaining = (await api.searchOpenOrders(config.scope.accountId))
  .filter((o) => o.contractId === config.scope.contractId).length;
console.log("remaining", remaining);
