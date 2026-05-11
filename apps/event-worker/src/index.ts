export const eventWorkerApp = "@roboops/event-worker";

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`${eventWorkerApp} placeholder`);
}

