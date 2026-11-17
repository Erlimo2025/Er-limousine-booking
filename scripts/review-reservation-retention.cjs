'use strict';

const {Pool} = require('pg');
const {connectionOptions} = require('../storage/postgres');
const {readRetentionPage} = require('../storage/reservation-retention');

const HELP = `Usage: node scripts/review-reservation-retention.cjs [options]

Read one page of the owner retention review inventory as JSON.
Use DATABASE_URL from the authorized operator's environment.

  --as-of <UTC instant>  Checkpoint date basis, for example 2026-11-17T17:00:00.000Z
  --limit <1-250>        Maximum records in this page (default 100)
  --cursor <value>       Continue using the previous page's nextCursor and asOf
  --help                Show this help without connecting to a database

Secure the output and inspect details through authenticated Dispatch.
External obligations, disputes and holds require owner verification.
`;

function parseArgs(argv, {now = () => Date.now()} = {}) {
  const invalid = () => { throw new Error('Invalid retention inventory options.'); };
  if (!Array.isArray(argv)) invalid();
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1];
    if (!['--as-of', '--limit', '--cursor'].includes(option) || values.has(option) ||
        typeof value !== 'string' || !value || value.startsWith('--')) invalid();
    values.set(option, value);
  }
  const asOf = values.get('--as-of') || new Date(now()).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf) ||
      !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) invalid();
  const limit = values.get('--limit') || '100';
  if (!/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|250)$/.test(limit)) invalid();
  const cursor = values.get('--cursor') || null;
  if (cursor && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024 || !values.has('--as-of'))) invalid();
  return {help: false, asOf, limit: Number(limit), cursor};
}

async function runInventory(argv, {
  env = process.env,
  createPool = options => new Pool(options),
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text),
  now = () => Date.now()
} = {}) {
  try {
    const options = parseArgs(argv, {now});
    if (options.help) {
      stdout(HELP);
      return 0;
    }
    const pool = createPool({...connectionOptions(env), max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
      statement_timeout: 12000, application_name: 'er-retention-review'});
    // pg emits idle connection failures separately. Its underlying error can contain connection details.
    pool.on('error', () => {});
    let page;
    try {
      page = await readRetentionPage(pool, {asOf: options.asOf, limit: options.limit, cursor: options.cursor});
    } finally {
      await pool.end();
    }
    stdout(JSON.stringify(page, null, 2) + '\n');
    return 0;
  } catch (_) {
    stderr('Retention inventory unavailable. Check options, authorized database access and schema readiness.\n');
    return 1;
  }
}

if (require.main === module) {
  void runInventory(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = {parseArgs, runInventory};
