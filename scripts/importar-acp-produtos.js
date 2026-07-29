require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function normalizarConnectionString(valor) {
  return String(valor || '').replace(/^postgresql:(?=postgresql:\/\/)/, '');
}

async function main() {
  const seedPath = path.join(__dirname, 'acp-produtos-seed.json');
  const produtos = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const connectionString = normalizarConnectionString(process.env.DATABASE_URL);

  if (!connectionString) {
    throw new Error('DATABASE_URL não configurado.');
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : false
  });

  let inseridos = 0;
  let atualizados = 0;
  const conflitos = [];

  try {
    await pool.query("ALTER TABLE produtos ADD COLUMN IF NOT EXISTS colecao_id INTEGER DEFAULT 0");
    await pool.query("ALTER TABLE produtos ADD COLUMN IF NOT EXISTS empresa TEXT DEFAULT 'acp'");

    for (const produto of produtos) {
      const codigo = String(produto.codigo || '').trim();
      const descricao = String(produto.descricao || '').trim();

      if (!codigo || !descricao) {
        throw new Error(`Produto inválido no seed: ${JSON.stringify(produto)}`);
      }

      const existente = await pool.query(
        'SELECT id, empresa FROM produtos WHERE codigo = $1 LIMIT 1',
        [codigo]
      );

      if (existente.rowCount) {
        const empresaAtual = String(existente.rows[0].empresa || 'acp').toLowerCase();

        if (empresaAtual && empresaAtual !== 'acp') {
          conflitos.push(`${codigo} (${empresaAtual})`);
          continue;
        }

        await pool.query(
          `UPDATE produtos
           SET descricao = $2,
               unidade = $3,
               preco_venda = $4,
               estoque = $5,
               status = 'ativo',
               colecao_id = $6,
               empresa = 'acp'
           WHERE codigo = $1`,
          [
            codigo,
            descricao,
            produto.unidade || 'UN',
            Number(produto.preco_venda || 0),
            Number(produto.estoque || 0),
            Number(produto.colecao_id || 0)
          ]
        );
        atualizados += 1;
        continue;
      }

      await pool.query(
        `INSERT INTO produtos
         (codigo, descricao, unidade, preco_venda, estoque, status, colecao_id, empresa)
         VALUES ($1, $2, $3, $4, $5, 'ativo', $6, 'acp')`,
        [
          codigo,
          descricao,
          produto.unidade || 'UN',
          Number(produto.preco_venda || 0),
          Number(produto.estoque || 0),
          Number(produto.colecao_id || 0)
        ]
      );
      inseridos += 1;
    }

    if (conflitos.length) {
      console.warn(`Códigos ignorados por pertencerem a outra empresa: ${conflitos.join(', ')}`);
    }

    const codigos = produtos.map((produto) => String(produto.codigo));
    const verificacao = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM produtos
       WHERE empresa = 'acp'
       AND status = 'ativo'
       AND codigo = ANY($1::text[])`,
      [codigos]
    );

    console.log(`Produtos ACP no seed: ${produtos.length}`);
    console.log(`Inseridos: ${inseridos}`);
    console.log(`Atualizados: ${atualizados}`);
    console.log(`Conflitos: ${conflitos.length}`);
    console.log(`Ativos encontrados na ACP após importação: ${verificacao.rows[0].total}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
