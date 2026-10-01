import { assertIntegrationSchema, createIntegrationPool } from './integrationRuntime.js';

const connectionString = process.env['TEST_DATABASE_URL'];
if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required to prepare the E2E database.');
}

const url = new URL(connectionString);
const schema = url.searchParams.get('schema');

if (schema === null) {
  console.log(JSON.stringify({ success: true, schema: null, action: 'database-schema' }, null, 2));
} else {
  assertIntegrationSchema(schema);
  const pool = createIntegrationPool(connectionString);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    console.log(JSON.stringify({ success: true, schema, action: 'created-or-reused' }, null, 2));
  } finally {
    await pool.end();
  }
}
