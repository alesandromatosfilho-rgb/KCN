const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL não configurado no .env');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false
});

function converterPlaceholders(sql) {
  let i = 0;

  return sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/IFNULL/g, 'COALESCE');
}

async function query(sql, params = []) {
  const text = converterPlaceholders(sql);
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

  const result = await pool.query(text, params);

  return {
    id: result.rows?.[0]?.id,
    changes: result.rowCount
  };
}

module.exports = {
  pool,
  query,
  get,
  run
};