export const fleetPersistencePackage = "@roboops/fleet-persistence";

export {
  buildMigrationPlan,
  defaultMigrationDirectoryUrl,
  didMigrationTransactionApply,
  fleetPersistenceSchema,
  formatMigrationTransaction,
  getOrderedMigrationFileNames,
  localPostgresDatabaseUrl,
  migrationAppliedOutputMarker,
  migrationFileNamePattern,
  readOrderedSqlMigrations
} from "./postgres-migrations.js";
export type {
  AppliedMigration,
  MigrationPlanEntry,
  SqlMigration
} from "./postgres-migrations.js";
export {
  readAppliedPostgresMigrations,
  runPostgresMigrations,
  runPsql
} from "./postgres-migration-runner.js";
export type {
  PostgresMigrationRunnerOptions,
  PostgresMigrationRunSummary,
  PsqlCommandOptions
} from "./postgres-migration-runner.js";
export { PostgresDomainStateRepository } from "./postgres-domain-state-repository.js";
export type {
  PostgresDomainStateRepositoryOptions
} from "./postgres-domain-state-repository.js";
export {
  PostgresOutboxStore,
  maxOutboxErrorTextLength,
  sanitizeOutboxErrorText
} from "./postgres-outbox-store.js";
export type {
  ClaimedOutboxEvent,
  ClaimOutboxBatchOptions,
  MarkOutboxEventPublishedOptions,
  PostgresOutboxStoreOptions,
  RecordOutboxEventFailureOptions
} from "./postgres-outbox-store.js";
export { InMemoryDomainStateRepository } from "./repository.js";
export type {
  DomainStateMutation,
  DomainStateMutator,
  DomainStateRepository
} from "./repository.js";
