const { createStore } = require("./lib/store");
const { createApp } = require("./lib/createApp");
const { seedIfEmpty } = require("./lib/seed");

const PORT = process.env.PORT || 3000;

async function main() {
  const store = createStore();
  await store.init();
  if (store.kind === "file") {
    const seeded = await seedIfEmpty(store);
    if (seeded) console.log("Loaded sample shop into " + store.file);
  }
  const app = createApp(store);
  app.listen(PORT, "0.0.0.0", () => console.log("Counter is listening on port " + PORT));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Startup failed", error);
    process.exit(1);
  });
}

module.exports = { main };
