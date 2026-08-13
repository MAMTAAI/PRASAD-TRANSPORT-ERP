// server/db/migrate-cloud.js — run the migration set against the CLOUD replica
// (through the sync tunnel). Same runner, aws-first target resolution.
process.env.DB_TARGET = 'aws';
await import('./migrate.js');
