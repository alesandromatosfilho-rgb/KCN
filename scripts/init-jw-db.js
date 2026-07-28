const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

async function runCommand(cmd, env = {}) {
  return new Promise((resolve, reject) => {
    const p = exec(cmd, { env: { ...process.env, ...env }, cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
  });
}

async function main() {
  const jwUrl = process.env.DATABASE_URL_JW;
  if (!jwUrl) {
    console.error('ERRO: DATABASE_URL_JW não definido. Ex: postgres://user:pass@host:5432/jw_db');
    process.exit(1);
  }

  console.log('Usando DATABASE_URL_JW:', jwUrl.replace(/:(.+)@/, ':*****@'));

  // 1) Run existing table creation script with env override
  try {
    console.log('Executando scripts/criar-tabelas-postgres.js (usando DATABASE_URL_JW)...');
    await runCommand('node scripts/criar-tabelas-postgres.js', { DATABASE_URL: jwUrl });
    console.log('Tabelas criadas (ou verificadas) com sucesso.');
  } catch (e) {
    console.error('Erro ao executar criar-tabelas-postgres.js:', e.stderr || e.err || e);
    process.exit(1);
  }

  // 2) Load JW seed and insert into clientes if exists
  const seedPathCandidates = [
    path.join(__dirname, 'jw-clientes-seed.json'),
    path.join(__dirname, '..', 'jw-clientes-seed.json')
  ];

  let seed = [];
  for (const p of seedPathCandidates) {
    if (fs.existsSync(p)) {
      try {
        seed = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`Seed JW carregado: ${p} (${seed.length} registros)`);
        break;
      } catch (e) {
        console.warn('Erro lendo seed JW em', p, e.message);
      }
    }
  }

  if (!seed.length) {
    console.warn('Nenhum seed JW encontrado — pulando importação de clientes.');
    process.exit(0);
  }

  // Connect using direct pool
  const pool = new Pool({ connectionString: jwUrl, ssl: jwUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : false });

  try {
    for (const r of seed) {
      try {
        await pool.query(`INSERT INTO clientes 
          (razao_social, nome_fantasia, cnpj_cpf, email, telefone, cidade, estado, endereco, empresa, codigo_origem, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (codigo_origem) DO NOTHING`, [
          r.razao_social || r.nome || '',
          r.nome_fantasia || r.nome || '',
          r.cnpj_cpf || r.cpf || '',
          r.email || '',
          r.telefone || r.fone || '',
          r.cidade || '',
          r.estado || '',
          r.endereco || '',
          'jw',
          r.codigo_origem || null,
          'ativo'
        ]);
      } catch (ie) {
        console.warn('Falha inserindo cliente', r.codigo_origem || r.razao_social || r.nome, ie.message);
      }
    }

    console.log('Importação JW concluída');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});