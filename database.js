const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_CONNECTION = process.env.DATABASE_URL;
const JW_CONNECTION = process.env.DATABASE_URL_JW || null;

if (!DEFAULT_CONNECTION) {
  throw new Error('DATABASE_URL não configurado no .env');
}

function makePool(connectionString) {
  return new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : false
  });
}

// default pool (used for ACP and scripts)
const poolDefault = makePool(DEFAULT_CONNECTION);
// optional JW pool (if configured)
const poolJw = JW_CONNECTION ? makePool(JW_CONNECTION) : null;

const als = new AsyncLocalStorage();

function converterPlaceholders(sql) {
  let i = 0;

  return sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/IFNULL/g, 'COALESCE');
}

function getPoolForEmpresa(empresa) {
  const emp = String(empresa || 'acp').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (emp === 'jw' && poolJw) {
    return poolJw;
  }

  return poolDefault;
}

async function query(sql, params = []) {
  const text = converterPlaceholders(sql);
  const store = als.getStore();
  const pool = getPoolForEmpresa(store?.empresa);
  const result = await pool.query(text, params);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0];
}

async function run(sql, params = []) {
  let text = converterPlaceholders(sql);

  const isInsert = /^\s*INSERT\s+/i.test(text);
  const hasReturning = /\sRETURNING\s+/i.test(text);

  if (isInsert && !hasReturning) {
    text += ' RETURNING id';
  }

  const store = als.getStore();
  const pool = getPoolForEmpresa(store?.empresa);

  const result = await pool.query(text, params);

  return {
    id: result.rows?.[0]?.id,
    changes: result.rowCount
  };
}

// Express middleware to set empresa in AsyncLocalStorage per request
function empresaMiddleware(req, res, next) {
  // priority: query param -> body -> header X-Empresa -> default 'acp'
  const empresaRaw = (req.query && req.query.empresa) || (req.body && req.body.empresa) || req.headers['x-empresa'] || 'acp';
  const empresa = String(empresaRaw || 'acp').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  als.run({ empresa }, () => next());
}

module.exports = {
  // export default pool for scripts/tools that import pool directly
  pool: poolDefault,
  query,
  get,
  run,
  empresaMiddleware,
  // exported for debug or manual use
  _internal: {
    poolDefault,
    poolJw,
    getPoolForEmpresa,
    als
  }
};
