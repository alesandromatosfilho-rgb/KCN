require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const app = express();
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  next();
});
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { pool, query, get, run, empresaMiddleware } = require('./database');
const SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT) || 3001;

if (!SECRET) {
  throw new Error('JWT_SECRET não configurado no .env');
}

app.set('trust proxy', 1);

/*
  Helmet/CSP foi removido temporariamente porque o index.html ainda usa onclick inline.
  Depois, quando removermos os onclick do HTML, podemos voltar com helmet().
*/

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3001',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(empresaMiddleware);
app.use((req, res, next) => {
  const aceitaHtml = String(req.headers.accept || '').includes('text/html');
  const caminhoHtml = req.path === '/' || req.path.endsWith('.html');

  if (caminhoHtml || aceitaHtml) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }

  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Debug endpoint: mostra qual pool/DB está sendo usado para uma empresa (requer auth)
app.get('/api/debug/db-info', auth, async (req, res) => {
  const empresa = normalizarEmpresa(req.query.empresa || req.body?.empresa || req.headers['x-empresa']);
  try {
    const db = require('./database');
    const internal = db._internal || {};
    const hasJw = !!internal.poolJw;
    let poolName = 'default';
    try {
      const pool = internal.getPoolForEmpresa(empresa);
      poolName = pool === internal.poolJw ? 'jw' : 'default';
      // attempt to read current_database() to be sure
      const result = await (pool.query ? pool.query('SELECT current_database()') : Promise.resolve(null));
      const currentDb = result && result.rows ? result.rows[0].current_database : null;
      res.json({ empresa, pool: poolName, hasJwPool: hasJw, current_database: currentDb });
    } catch (innerErr) {
      // getPoolForEmpresa can throw if JW not configured
      res.status(500).json({ empresa, error: innerErr.message, hasJwPool: hasJw });
    }
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

console.log('Banco de dados: PostgreSQL');

function normalizarEmpresa(empresa) {
  const e = String(empresa || 'acp')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (e === 'acp') return 'acp';
  if (e === 'sleep') return 'sleep';
  if (e === 'tais' || e === 'thais') return 'tais';
  if (e === 'jw') return 'jw';
  return 'acp';
}

function empresaDaRequisicao(req) {
  return normalizarEmpresa(
    req.query?.empresa || req.body?.empresa || req.headers['x-empresa']
  );
}

function normalizarTabelaPedido(valor, empresa) {
  const tabela = String(valor || '').trim();
  const emp = normalizarEmpresa(empresa);
  const opcoes = emp === 'acp' ? ['1', '12', '29'] : ['1', '2'];
  return opcoes.includes(tabela) ? tabela : '';
}

async function garantirColunaFretePedido() {
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS frete TEXT DEFAULT ''`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS forma_pagamento TEXT DEFAULT ''`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS emitir_em TEXT DEFAULT ''`);
  await run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tabela TEXT DEFAULT ''`);
}


function normalizarItemPedidoSeguro(item) {
  const produto_id = Number(item?.produto_id || 0);
  const produto_codigo = String(item?.produto_codigo || '').trim();
  const produto_nome = String(item?.produto_nome || '').trim();
  const cor_item = String(item?.cor_item || '').trim();

  const quantidade = Number(item?.quantidade || 0);
  const preco_unitario = Number(item?.preco_unitario || 0);
  const descontoBruto = Number(item?.desconto || 0);
  const desconto = Number.isFinite(descontoBruto) ? Math.max(0, Math.min(100, descontoBruto)) : 0;

  const temProduto = produto_id > 0 || produto_codigo.length > 0 || produto_nome.length > 0;
  const quantidadeValida = Number.isFinite(quantidade) && quantidade > 0;
  const precoValido = Number.isFinite(preco_unitario) && preco_unitario > 0;

  if (!temProduto || !quantidadeValida || !precoValido) {
    return null;
  }

  const total = quantidade * preco_unitario * (1 - desconto / 100);

  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  return {
    produto_id,
    produto_codigo,
    produto_nome,
    cor_item,
    quantidade,
    preco_unitario,
    desconto,
    total
  };
}

function normalizarItensPedidoSeguro(itens) {
  if (!Array.isArray(itens)) return [];

  return itens
    .map(normalizarItemPedidoSeguro)
    .filter(Boolean);
}

function calcularTotalPedidoSeguro(itensValidos) {
  return itensValidos.reduce((acc, item) => acc + Number(item.total || 0), 0);
}

function obterIntervaloMes(mes) {
  const agora = new Date();
  const mesSeguro = /^\d{4}-\d{2}$/.test(String(mes || ''))
    ? String(mes)
    : `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;

  const [ano, mesNumero] = mesSeguro.split('-').map(Number);
  const inicio = new Date(Date.UTC(ano, mesNumero - 1, 1, 0, 0, 0));
  const fim = new Date(Date.UTC(ano, mesNumero, 1, 0, 0, 0));

  return {
    mes: mesSeguro,
    inicio: inicio.toISOString().slice(0, 10),
    fim: fim.toISOString().slice(0, 10)
  };
}

function formatarMesReferencia(data) {
  if (!data) return '';
  const valor = String(data);
  if (/^\d{4}-\d{2}/.test(valor)) {
    return valor.slice(0, 7);
  }
  return '';
}

function somarDiasISO(dataISO, dias) {
  const partes = String(dataISO || '').split('-').map(Number);
  if (partes.length !== 3 || partes.some(isNaN)) {
    return dataISO;
  }

  const data = new Date(Date.UTC(partes[0], partes[1] - 1, partes[2] + dias));
  return data.toISOString().slice(0, 10);
}


function variantesEmpresaRelatorio(empresa) {
  const emp = String(empresa || 'acp')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (emp === 'todos' || emp === 'todas' || emp === 'all') {
    return [];
  }

  if (emp === 'sleep') {
    return [
      'sleep',
      'sleep colchões',
      'sleep colchoes',
      'sleep móveis',
      'sleep moveis'
    ];
  }

  if (emp === 'tais' || emp === 'thais') {
    return [
      'tais',
      'thais',
      'thaís',
      'tais móveis',
      'tais moveis',
      'thaís móveis',
      'thais moveis'
    ];
  }

  if (emp === 'jw') {
    return ['jw', 'jw moveis', 'jw móveis'];
  }

  return [
    'acp',
    'acp indústria de móveis',
    'acp industria de moveis',
    'acp móveis',
    'acp moveis'
  ];
}
function filtroEmpresaRelatorio(alias, empresa) {
  const variantes = variantesEmpresaRelatorio(empresa);

  if (!variantes.length) {
    return {
      sql: '1=1',
      params: []
    };
  }

  const coluna = alias ? `${alias}.empresa` : 'empresa';

  return {
    sql: `LOWER(COALESCE(${coluna}, '')) IN (${variantes.map(() => '?').join(',')})`,
    params: variantes
  };
}

function empresaRespostaRelatorio(empresa) {
  const emp = String(empresa || 'acp')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (emp === 'todos' || emp === 'todas' || emp === 'all') return 'todos';
  if (emp === 'sleep') return 'sleep';
  if (emp === 'tais' || emp === 'thais') return 'tais';
  if (emp === 'jw') return 'jw';
  return 'acp';
}


function obterIntervaloRelatorio(queryParams) {
  const dataInicio = String(queryParams.data_inicio || '').slice(0, 10);
  const dataFim = String(queryParams.data_fim || '').slice(0, 10);

  if (/^\d{4}-\d{2}-\d{2}$/.test(dataInicio) && /^\d{4}-\d{2}-\d{2}$/.test(dataFim)) {
    return {
      mes: dataInicio.slice(0, 7),
      inicio: dataInicio,
      fim: somarDiasISO(dataFim, 1),
      dataInicio,
      dataFim,
      label: dataInicio + ' até ' + dataFim
    };
  }

  const intervaloMes = obterIntervaloMes(queryParams.mes);
  return {
    mes: intervaloMes.mes,
    inicio: intervaloMes.inicio,
    fim: intervaloMes.fim,
    dataInicio: intervaloMes.inicio,
    dataFim: somarDiasISO(intervaloMes.fim, -1),
    label: intervaloMes.mes
  };
}


async function garantirColunasProdutos() {
  try {
    await run("ALTER TABLE produtos ADD COLUMN IF NOT EXISTS colecao_id INTEGER DEFAULT 0");
    await run("ALTER TABLE produtos ADD COLUMN IF NOT EXISTS empresa TEXT DEFAULT 'acp'");
  } catch (e) {
    console.warn('Aviso ao garantir colunas de produtos:', e.message);
  }
}

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }

  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido' });
  }
}

function loadJsonSeed(candidates) {
  for (const seedPath of candidates) {
    try {
      if (fs.existsSync(seedPath)) {
        const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        console.log(`Seed carregado: ${seedPath} (${data.length} registros)`);
        return data;
      }
    } catch (e) {
      console.warn('Seed erro em', seedPath, e.message);
    }
  }

  return [];
}

let ACP_CLIENTES_SEED = loadJsonSeed([
  path.join(__dirname, 'scripts', 'acp-clientes-seed.json'),
  path.join(__dirname, 'acp-clientes-seed.json')
]);

let JW_CLIENTES_SEED = loadJsonSeed([
  path.join(__dirname, 'scripts', 'jw-clientes-seed.json'),
  path.join(__dirname, 'jw-clientes-seed.json')
]);

let SLEEP_TAIS_CLIENTES_SEED = loadJsonSeed([
  path.join(__dirname, 'scripts', 'sleep-tais-clientes-seed.json'),
  path.join(__dirname, 'sleep-tais-clientes-seed.json')
]);

if (!SLEEP_TAIS_CLIENTES_SEED.length) {
  const legS = loadJsonSeed([
    path.join(__dirname, 'scripts', 'sleep-clientes-seed.json'),
    path.join(__dirname, 'sleep-clientes-seed.json')
  ]);

  const legT = loadJsonSeed([
    path.join(__dirname, 'scripts', 'tais-clientes-seed.json'),
    path.join(__dirname, 'tais-clientes-seed.json')
  ]);

  const map = new Map();

  [...legS, ...legT].forEach((r) => {
    if (r && r.codigo_origem) {
      map.set(String(r.codigo_origem), r);
    }
  });

  SLEEP_TAIS_CLIENTES_SEED = Array.from(map.values()).sort((x, y) =>
    String(x.codigo_origem).localeCompare(String(y.codigo_origem), 'pt', { numeric: true })
  );

  if (SLEEP_TAIS_CLIENTES_SEED.length) {
    console.warn(`Usando fallback sleep+tais legado (${SLEEP_TAIS_CLIENTES_SEED.length} registros).`);
  }
}

if (!ACP_CLIENTES_SEED.length) {
  console.warn('Sem acp-clientes-seed.json — lista ACP ficará vazia até importar.');
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Tente novamente em alguns minutos.' }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, senha } = req.body;

  try {
    if (!email || !senha) {
      return res.status(400).json({ erro: 'Informe email e senha' });
    }

    const usuario = await get(
      'SELECT * FROM usuarios WHERE email = ?',
      [email]
    );

    if (!usuario || !bcrypt.compareSync(senha, usuario.senha)) {
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    const token = jwt.sign(
      {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil
      },
      SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil
      }
    });
  } catch (e) {
    console.error('Erro no login:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

app.get('/api/dashboard', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);
  const { mes, inicio, fim } = obterIntervaloMes(req.query.mes);

  try {
    const clientes = await get(
      `SELECT COUNT(*) as total 
       FROM clientes 
       WHERE status = 'ativo' AND empresa = ?`,
      [empresa]
    );

    // O painel de bordo mostra somente o mês atual.
    // Quando o mês vira, pedidos e faturamento aparecem zerados automaticamente,
    // mas os pedidos antigos continuam guardados nos relatórios.
    const pedidos = await get(
      `SELECT COUNT(*) as total 
       FROM pedidos 
       WHERE empresa = ?
       AND data_pedido >= ?
       AND data_pedido < ?`,
      [empresa, inicio, fim]
    );

    const abertos = await get(
      `SELECT COUNT(*) as total 
       FROM pedidos 
       WHERE status = 'aberto' AND empresa = ?
       AND data_pedido >= ?
       AND data_pedido < ?`,
      [empresa, inicio, fim]
    );

    const faturamento = await get(
      `SELECT COALESCE(SUM(total), 0) as total 
       FROM pedidos 
       WHERE empresa = ?
       AND data_pedido >= ?
       AND data_pedido < ?`,
      [empresa, inicio, fim]
    );

    const ultimosPedidos = await query(
      `SELECT 
        p.id,
        p.numero,
        p.data_pedido,
        p.data_entrega,
        p.frete,
        p.total,
        p.status,
        p.cor,
        c.razao_social as cliente_nome
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id AND c.empresa = p.empresa
       WHERE p.empresa = ?
       AND p.data_pedido >= ?
       AND p.data_pedido < ?
       ORDER BY p.id DESC
       LIMIT 5`,
      [empresa, inicio, fim]
    );

    res.json({
      mesReferencia: mes,
      totalClientes: clientes?.total || 0,
      totalPedidos: pedidos?.total || 0,
      pedidosAbertos: abertos?.total || 0,
      faturamento: faturamento?.total || 0,
      ultimosPedidos
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── RELATÓRIOS MENSAIS ─────────────────────────────────────────────────────

app.get('/api/relatorios/meses', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const rows = await query(
      `SELECT DISTINCT SUBSTR(CAST(data_pedido AS TEXT), 1, 7) as mes
       FROM pedidos
       WHERE empresa = ?
       AND data_pedido IS NOT NULL
       ORDER BY mes DESC`,
      [empresa]
    );

    res.json(rows.filter(r => r.mes).map(r => r.mes));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});


app.get('/api/relatorios/resumo-empresas', auth, async (req, res) => {
  const intervalo = obterIntervaloRelatorio(req.query);
  const { inicio, fim, dataInicio, dataFim, label } = intervalo;

  const empresas = [
    { id: 'acp', nome: 'ACP Indústria de Móveis' },
    { id: 'sleep', nome: 'Sleep Colchões' },
    { id: 'tais', nome: 'Thaís Móveis' },
    { id: 'jw', nome: 'JW Móveis' }
  ];

  try {
    await garantirColunaFretePedido();

    const resultados = [];

    for (const emp of empresas) {
      const filtroClientes = filtroEmpresaRelatorio('', emp.id);
      const filtroPedidos = filtroEmpresaRelatorio('', emp.id);

      const clientes = await get(
        `SELECT COUNT(*) as total
         FROM clientes
         WHERE status = 'ativo'
         AND ${filtroClientes.sql}`,
        filtroClientes.params
      );

      const pedidos = await get(
        `SELECT COUNT(*) as total
         FROM pedidos
         WHERE ${filtroPedidos.sql}
         AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) >= ?
         AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) < ?`,
        [...filtroPedidos.params, inicio, fim]
      );

      const abertos = await get(
        `SELECT COUNT(*) as total
         FROM pedidos
         WHERE status = 'aberto'
         AND ${filtroPedidos.sql}
         AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) >= ?
         AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) < ?`,
        [...filtroPedidos.params, inicio, fim]
      );

      const faturamento = await get(
        `SELECT COALESCE(SUM(total), 0) as total
         FROM pedidos
         WHERE ${filtroPedidos.sql}
         AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) >= ?
         AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) < ?`,
        [...filtroPedidos.params, inicio, fim]
      );

      resultados.push({
        empresa: emp.id,
        nome: emp.nome,
        totalClientes: Number(clientes?.total || 0),
        totalPedidos: Number(pedidos?.total || 0),
        pedidosAbertos: Number(abertos?.total || 0),
        faturamento: Number(faturamento?.total || 0)
      });
    }

    res.json({
      periodo: {
        inicio: dataInicio,
        fim: dataFim,
        label
      },
      empresas: resultados
    });
  } catch (e) {
    console.error('Erro no resumo por empresa:', e.message);
    res.status(500).json({ erro: e.message });
  }
});


app.get('/api/relatorios/mensal', auth, async (req, res) => {
  const empresaParam = req.query.empresa || 'acp';
  const empresa = empresaRespostaRelatorio(empresaParam);
  const intervalo = obterIntervaloRelatorio(req.query);
  const { mes, inicio, fim, dataInicio, dataFim, label } = intervalo;

  try {
    await garantirColunaFretePedido();

    const filtroResumo = filtroEmpresaRelatorio('', empresaParam);
    const filtroPedido = filtroEmpresaRelatorio('p', empresaParam);

    const resumo = await get(
      `SELECT 
        COUNT(*) as total_pedidos,
        COALESCE(SUM(total), 0) as faturamento,
        SUM(CASE WHEN status = 'aberto' THEN 1 ELSE 0 END) as pedidos_abertos,
        SUM(CASE WHEN status = 'aprovado' THEN 1 ELSE 0 END) as pedidos_aprovados,
        SUM(CASE WHEN status = 'faturado' THEN 1 ELSE 0 END) as pedidos_faturados,
        SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END) as pedidos_cancelados,
        COUNT(DISTINCT cliente_id) as clientes_atendidos
       FROM pedidos
       WHERE ${filtroResumo.sql}
       AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) >= ?
       AND SUBSTR(CAST(data_pedido AS TEXT), 1, 10) < ?`,
      [...filtroResumo.params, inicio, fim]
    );

    const pedidos = await query(
      `SELECT 
        p.*,
        c.razao_social as cliente_nome,
        c.nome_fantasia as cliente_fantasia,
        c.cnpj_cpf as cliente_cnpj_cpf,
        c.endereco as cliente_endereco,
        c.cidade as cliente_cidade,
        c.estado as cliente_estado,
        c.telefone as cliente_telefone,
        c.email as cliente_email,
        c.codigo_origem as cliente_codigo_origem
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id AND c.empresa = p.empresa
       WHERE ${filtroPedido.sql}
       AND SUBSTR(CAST(p.data_pedido AS TEXT), 1, 10) >= ?
       AND SUBSTR(CAST(p.data_pedido AS TEXT), 1, 10) < ?
       ORDER BY p.data_pedido DESC, p.id DESC`,
      [...filtroPedido.params, inicio, fim]
    );

    const itens = pedidos.length
      ? await query(
          `SELECT *
           FROM pedido_itens
           WHERE pedido_id IN (${pedidos.map(() => '?').join(',')})
           ORDER BY pedido_id, id`,
          pedidos.map(p => p.id)
        )
      : [];

    const itensPorPedido = {};
    itens.forEach(item => {
      const key = String(item.pedido_id);
      if (!itensPorPedido[key]) itensPorPedido[key] = [];
      itensPorPedido[key].push(item);
    });

    const pedidosComItens = pedidos.map(p => ({
      ...p,
      itens: itensPorPedido[String(p.id)] || []
    }));

    const clientes = await query(
      `SELECT 
        c.id,
        c.razao_social,
        c.nome_fantasia,
        c.cnpj_cpf,
        c.cidade,
        c.estado,
        c.telefone,
        c.email,
        COUNT(p.id) as total_pedidos,
        COALESCE(SUM(p.total), 0) as total_comprado
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id AND c.empresa = p.empresa
       WHERE ${filtroPedido.sql}
       AND SUBSTR(CAST(p.data_pedido AS TEXT), 1, 10) >= ?
       AND SUBSTR(CAST(p.data_pedido AS TEXT), 1, 10) < ?
       GROUP BY c.id, c.razao_social, c.nome_fantasia, c.cnpj_cpf, c.cidade, c.estado, c.telefone, c.email
       ORDER BY total_comprado DESC, c.razao_social`,
      [...filtroPedido.params, inicio, fim]
    );

    res.json({
      empresa,
      empresaSolicitada: empresaParam,
      mes,
      inicio,
      fim,
      periodo: {
        inicio: dataInicio,
        fim: dataFim,
        label
      },
      resumo: {
        totalPedidos: Number(resumo?.total_pedidos || 0),
        faturamento: Number(resumo?.faturamento || 0),
        pedidosAbertos: Number(resumo?.pedidos_abertos || 0),
        pedidosAprovados: Number(resumo?.pedidos_aprovados || 0),
        pedidosFaturados: Number(resumo?.pedidos_faturados || 0),
        pedidosCancelados: Number(resumo?.pedidos_cancelados || 0),
        clientesAtendidos: Number(resumo?.clientes_atendidos || 0)
      },
      pedidos: pedidosComItens,
      clientes
    });
  } catch (e) {
    console.error('Erro no relatório mensal:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── CLIENTES ───────────────────────────────────────────────────────────────

app.get('/api/clientes', auth, async (req, res) => {
  const busca = req.query.busca ? `%${req.query.busca}%` : '%';
  const empresa = empresaDaRequisicao(req);

  try {
    const rows = await query(
      `SELECT * 
       FROM clientes 
       WHERE empresa = ?
       AND (
         razao_social LIKE ?
         OR IFNULL(nome_fantasia,'') LIKE ?
         OR IFNULL(cnpj_cpf,'') LIKE ?
         OR IFNULL(cidade,'') LIKE ?
         OR IFNULL(codigo_origem,'') LIKE ?
         OR IFNULL(endereco,'') LIKE ?
       )
       ORDER BY razao_social`,
      [empresa, busca, busca, busca, busca, busca, busca]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/clientes/:id', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const row = await get(
      'SELECT * FROM clientes WHERE id = ? AND empresa = ?',
      [req.params.id, empresa]
    );

    if (!row) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    res.json(row);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/clientes', auth, async (req, res) => {
  const {
    razao_social,
    nome_fantasia,
    cnpj_cpf,
    email,
    telefone,
    cidade,
    estado,
    endereco,
    empresa,
    codigo_origem
  } = req.body;

  if (!razao_social) {
    return res.status(400).json({ erro: 'Razão social é obrigatória' });
  }

  const emp = empresaDaRequisicao(req);

  try {
    const r = await run(
      `INSERT INTO clientes 
      (razao_social, nome_fantasia, cnpj_cpf, email, telefone, cidade, estado, endereco, empresa, codigo_origem, status) 
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        razao_social,
        nome_fantasia || '',
        cnpj_cpf || '',
        email || '',
        telefone || '',
        cidade || '',
        estado || '',
        endereco || '',
        emp,
        codigo_origem || null,
        'ativo'
      ]
    );

    res.status(201).json({
      id: r.id,
      mensagem: 'Cliente cadastrado com sucesso'
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/clientes/:id', auth, async (req, res) => {
  const {
    razao_social,
    nome_fantasia,
    cnpj_cpf,
    email,
    telefone,
    cidade,
    estado,
    endereco,
    status,
    empresa,
    codigo_origem
  } = req.body;

  const emp = empresaDaRequisicao(req);

  try {
    const r = await run(
      `UPDATE clientes 
       SET razao_social = ?, 
           nome_fantasia = ?, 
           cnpj_cpf = ?, 
           email = ?, 
           telefone = ?, 
           cidade = ?, 
           estado = ?, 
           endereco = ?, 
           status = ?, 
           empresa = ?, 
           codigo_origem = ?
       WHERE id = ? AND empresa = ?`,
      [
        razao_social,
        nome_fantasia || '',
        cnpj_cpf || '',
        email || '',
        telefone || '',
        cidade || '',
        estado || '',
        endereco || '',
        status || 'ativo',
        emp,
        codigo_origem || null,
        req.params.id,
        emp
      ]
    );

    if (!r.changes) {
      return res.status(404).json({ erro: 'Cliente nao encontrado nesta empresa' });
    }

    res.json({ mensagem: 'Cliente atualizado com sucesso' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/clientes/:id', auth, async (req, res) => {
  const clienteId = req.params.id;
  const empresa = empresaDaRequisicao(req);
  const remover = req.query.remover === '1';

  try {
    const cliente = await get(
      'SELECT id FROM clientes WHERE id = ? AND empresa = ?',
      [clienteId, empresa]
    );

    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado nesta empresa' });
    }

    if (!remover) {
      await run(
        'UPDATE clientes SET status = ? WHERE id = ? AND empresa = ?',
        ['inativo', clienteId, empresa]
      );

      return res.json({ mensagem: 'Cliente inativado com sucesso' });
    }

    const pedidos = await query(
      'SELECT id FROM pedidos WHERE cliente_id = ? AND empresa = ?',
      [clienteId, empresa]
    );

    for (const pedido of pedidos) {
      await run('DELETE FROM pedido_itens WHERE pedido_id = ?', [pedido.id]);
    }

    await run(
      'DELETE FROM pedidos WHERE cliente_id = ? AND empresa = ?',
      [clienteId, empresa]
    );

    await run(
      'DELETE FROM clientes WHERE id = ? AND empresa = ?',
      [clienteId, empresa]
    );

    res.json({ mensagem: 'Cliente removido com sucesso' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── PRODUTOS ────────────────────────────────────────────────────────────────

app.get('/api/produtos', auth, async (req, res) => {
  const busca = req.query.busca ? `%${req.query.busca}%` : '%';
  const empresa = req.query.empresa ? normalizarEmpresa(req.query.empresa) : empresaDaRequisicao(req);

  try {
    let sql = `
      SELECT * 
      FROM produtos 
      WHERE status = 'ativo'
      AND (descricao LIKE ? OR codigo LIKE ?)
    `;

    const params = [busca, busca];

    if (empresa) {
      sql += ' AND empresa = ?';
      params.push(empresa);
    }

    sql += ' ORDER BY colecao_id, descricao';

    const rows = await query(sql, params);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/produtos', auth, async (req, res) => {
  const { codigo, descricao, unidade, preco_venda, estoque, colecao_id, empresa } = req.body;
  const emp = empresaDaRequisicao(req);

  if (!codigo || !descricao) {
    return res.status(400).json({ erro: 'Código e descrição são obrigatórios' });
  }

  try {
    const r = await run(
      `INSERT INTO produtos 
      (codigo, descricao, unidade, preco_venda, estoque, status, colecao_id, empresa) 
      VALUES (?,?,?,?,?,?,?,?)`,
      [
        codigo,
        descricao,
        unidade || 'UN',
        Number(preco_venda || 0),
        Number(estoque || 0),
        'ativo',
        Number(colecao_id || 0),
        emp
      ]
    );

    res.status(201).json({
      id: r.id,
      mensagem: 'Produto cadastrado com sucesso'
    });
  } catch (e) {
    res.status(400).json({ erro: 'Código já existe ou dados inválidos: ' + e.message });
  }
});

app.put('/api/produtos/:id', auth, async (req, res) => {
  const { codigo, descricao, unidade, preco_venda, estoque, colecao_id, empresa } = req.body;
  const emp = empresaDaRequisicao(req);

  try {
    const r = await run(
      `UPDATE produtos 
       SET codigo = ?, 
           descricao = ?, 
           unidade = ?, 
           preco_venda = ?, 
           estoque = ?,
           colecao_id = ?,
           empresa = ?
       WHERE id = ? AND empresa = ?`,
      [
        codigo,
        descricao,
        unidade || 'UN',
        Number(preco_venda || 0),
        Number(estoque || 0),
        Number(colecao_id || 0),
        emp,
        req.params.id,
        emp
      ]
    );

    if (!r.changes) {
      return res.status(404).json({ erro: 'Produto nao encontrado nesta empresa' });
    }

    res.json({ mensagem: 'Produto atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});


app.delete('/api/produtos/:id', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const produto = await get(
      'SELECT id FROM produtos WHERE id = ? AND empresa = ?',
      [req.params.id, empresa]
    );

    if (!produto) {
      return res.status(404).json({ erro: 'Produto não encontrado' });
    }

    await run(
      'UPDATE produtos SET status = ? WHERE id = ? AND empresa = ?',
      ['inativo', req.params.id, empresa]
    );

    res.json({ mensagem: 'Produto removido com sucesso' });
  } catch (e) {
    console.error('Erro ao remover produto:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── PEDIDOS ─────────────────────────────────────────────────────────────────

app.get('/api/pedidos', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const rows = await query(
      `SELECT 
        p.*, 
        c.razao_social as cliente_nome, 
        u.nome as vendedor_nome
       FROM pedidos p
       JOIN clientes c ON c.id = p.cliente_id AND c.empresa = p.empresa
       LEFT JOIN usuarios u ON u.id = p.vendedor_id
       WHERE p.empresa = ?
       ORDER BY p.id DESC`,
      [empresa]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/pedidos/:id', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const pedido = await get(
      `SELECT 
        p.*, 
        c.razao_social as cliente_nome,
        c.nome_fantasia as cliente_fantasia,
        c.cnpj_cpf as cliente_cnpj_cpf,
        c.endereco as cliente_endereco,
        c.cidade as cliente_cidade,
        c.estado as cliente_estado,
        c.telefone as cliente_telefone,
        c.email as cliente_email,
        c.codigo_origem as cliente_codigo_origem
       FROM pedidos p 
       JOIN clientes c ON c.id = p.cliente_id AND c.empresa = p.empresa
       WHERE p.id = ? AND p.empresa = ?`,
      [req.params.id, empresa]
    );

    if (!pedido) {
      return res.status(404).json({ erro: 'Pedido não encontrado' });
    }

    const itens = await query(
      `SELECT 
        pi.*, 
        COALESCE(NULLIF(pi.produto_codigo, ''), pr.codigo, '') as produto_codigo,
        COALESCE(NULLIF(pi.produto_nome, ''), pr.descricao, 'Produto sem nome') as produto_nome,
        IFNULL(pi.cor_item, '') as cor_item
       FROM pedido_itens pi 
       LEFT JOIN produtos pr ON pr.id = pi.produto_id
       WHERE pi.pedido_id = ?`,
      [req.params.id]
    );

    res.json({ ...pedido, itens });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/pedidos', auth, async (req, res) => {
  const {
    cliente_id,
    data_entrega,
    frete,
    forma_pagamento,
    emitir_em,
    tabela,
    observacao,
    itens,
    empresa,
    cor
  } = req.body;

  const itensValidos = normalizarItensPedidoSeguro(itens);

  if (!cliente_id || !itensValidos.length) {
    return res.status(400).json({
      erro: 'Cliente e pelo menos um item válido são obrigatórios. O pedido não foi salvo para evitar zerar os dados.'
    });
  }

  const emp = empresaDaRequisicao(req);
  const emitirEmPedido = emp === 'jw' ? String(emitir_em || '').trim() : '';
  const tabelaPedido = ['acp', 'jw'].includes(emp) ? normalizarTabelaPedido(tabela, emp) : '';

  const total = calcularTotalPedidoSeguro(itensValidos);

  if (!Number.isFinite(total) || total <= 0) {
    return res.status(400).json({
      erro: 'Total inválido. O pedido não foi salvo para evitar zerar os dados.'
    });
  }

  try {
    await garantirColunaFretePedido();

    const numeroTemporario =
      'TEMP-PED-' + Date.now() + '-' + Math.floor(Math.random() * 100000);

    const r = await run(
      `INSERT INTO pedidos 
      (numero, cliente_id, vendedor_id, data_entrega, frete, forma_pagamento, emitir_em, tabela, observacao, total, empresa, cor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        numeroTemporario,
        cliente_id,
        req.usuario.id,
        data_entrega || '',
        frete || '',
        forma_pagamento || '',
        emitirEmPedido,
        tabelaPedido,
        observacao || '',
        total,
        emp,
        cor || null
      ]
    );

    const ano = new Date().getFullYear();
    const numero = `PED-${ano}-${String(r.id).padStart(4, '0')}`;

    await run(
      'UPDATE pedidos SET numero = ? WHERE id = ?',
      [numero, r.id]
    );

    for (const item of itensValidos) {
      const quantidade = Number(item.quantidade || 0);
      const preco = Number(item.preco_unitario || 0);
      const desconto = Number(item.desconto || 0);
      const itemTotal = quantidade * preco * (1 - desconto / 100);

      await run(
        `INSERT INTO pedido_itens 
        (pedido_id, produto_id, produto_codigo, produto_nome, cor_item, quantidade, preco_unitario, desconto, total) 
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          r.id,
          Number(item.produto_id || 0),
          item.produto_codigo || '',
          item.produto_nome || '',
          item.cor_item || '',
          quantidade,
          preco,
          desconto,
          itemTotal
        ]
      );
    }

    res.status(201).json({
      id: r.id,
      numero,
      mensagem: 'Pedido criado com sucesso'
    });
  } catch (e) {
    console.error('Erro ao criar pedido:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/pedidos/:id', auth, async (req, res) => {
  const {
    cliente_id,
    data_entrega,
    frete,
    forma_pagamento,
    emitir_em,
    tabela,
    observacao,
    itens,
    empresa,
    cor
  } = req.body;

  const pedidoId = req.params.id;
  const emp = empresaDaRequisicao(req);
  const emitirEmPedido = emp === 'jw' ? String(emitir_em || '').trim() : '';
  const tabelaPedido = ['acp', 'jw'].includes(emp) ? normalizarTabelaPedido(tabela, emp) : '';

  const itensValidos = normalizarItensPedidoSeguro(itens);

  if (!cliente_id || !itensValidos.length) {
    return res.status(400).json({
      erro: 'Edição bloqueada: o pedido veio sem itens válidos. Os dados antigos foram mantidos para evitar zerar o pedido.'
    });
  }

  const total = calcularTotalPedidoSeguro(itensValidos);

  if (!Number.isFinite(total) || total <= 0) {
    return res.status(400).json({
      erro: 'Edição bloqueada: total inválido. Os dados antigos foram mantidos para evitar zerar o pedido.'
    });
  }

  try {
    await garantirColunaFretePedido();

    const pedido = await get(
      'SELECT id FROM pedidos WHERE id = ? AND empresa = ?',
      [pedidoId, emp]
    );

    if (!pedido) {
      return res.status(404).json({ erro: 'Pedido não encontrado nesta empresa' });
    }

    await run(
      `UPDATE pedidos
       SET cliente_id = ?,
           data_entrega = ?,
           frete = ?,
           forma_pagamento = ?,
           emitir_em = ?,
           tabela = ?,
           observacao = ?,
           total = ?,
           empresa = ?,
           cor = ?
       WHERE id = ? AND empresa = ?`,
      [
        cliente_id,
        data_entrega || '',
        frete || '',
        forma_pagamento || '',
        emitirEmPedido,
        tabelaPedido,
        observacao || '',
        total,
        emp,
        cor || null,
        pedidoId,
        emp
      ]
    );

    await run('DELETE FROM pedido_itens WHERE pedido_id = ?', [pedidoId]);

    for (const item of itensValidos) {
      const quantidade = Number(item.quantidade || 0);
      const preco = Number(item.preco_unitario || 0);
      const desconto = Number(item.desconto || 0);
      const itemTotal = quantidade * preco * (1 - desconto / 100);

      await run(
        `INSERT INTO pedido_itens
        (pedido_id, produto_id, produto_codigo, produto_nome, cor_item, quantidade, preco_unitario, desconto, total)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          pedidoId,
          Number(item.produto_id || 0),
          item.produto_codigo || '',
          item.produto_nome || '',
          item.cor_item || '',
          quantidade,
          preco,
          desconto,
          itemTotal
        ]
      );
    }

    res.json({
      mensagem: 'Pedido atualizado com sucesso',
      total
    });
  } catch (e) {
    console.error('Erro ao editar pedido:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/pedidos/:id/status', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const r = await run(
      'UPDATE pedidos SET status = ? WHERE id = ? AND empresa = ?',
      [req.body.status, req.params.id, empresa]
    );

    if (!r.changes) {
      return res.status(404).json({ erro: 'Pedido nao encontrado nesta empresa' });
    }

    res.json({ mensagem: 'Status atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/pedidos/:id', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);
  const pedidoId = req.params.id;

  try {
    const pedido = await get(
      'SELECT id FROM pedidos WHERE id = ? AND empresa = ?',
      [pedidoId, empresa]
    );

    if (!pedido) {
      return res.status(404).json({ erro: 'Pedido não encontrado nesta empresa' });
    }

    await run('DELETE FROM pedido_itens WHERE pedido_id = ?', [pedidoId]);
    await run('DELETE FROM pedidos WHERE id = ? AND empresa = ?', [pedidoId, empresa]);

    res.json({ mensagem: 'Pedido removido com sucesso' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── ASSISTÊNCIAS ────────────────────────────────────────────────────────────

app.get('/api/assistencias', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);
  const busca = req.query.busca ? `%${req.query.busca}%` : '%';

  try {
    const rows = await query(
      `SELECT *
       FROM assistencias
       WHERE empresa = ?
       AND (
         cliente_nome LIKE ?
         OR motivo LIKE ?
         OR numero LIKE ?
       )
       ORDER BY id DESC`,
      [empresa, busca, busca, busca]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/assistencias/:id', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const assistencia = await get(
      'SELECT * FROM assistencias WHERE id = ? AND empresa = ?',
      [req.params.id, empresa]
    );

    if (!assistencia) {
      return res.status(404).json({ erro: 'Assistência não encontrada' });
    }

    const itens = await query(
      'SELECT * FROM assistencia_itens WHERE assistencia_id = ? ORDER BY id',
      [req.params.id]
    );

    assistencia.itens = itens;

    res.json(assistencia);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/assistencias', auth, async (req, res) => {
  const {
    cliente_id,
    cliente_nome,
    motivo,
    fabricacao,
    observacao,
    anexo,
    empresa,
    itens
  } = req.body;

  const emp = empresaDaRequisicao(req);

  if (!cliente_id) {
    return res.status(400).json({ erro: 'Cliente é obrigatório' });
  }

  if (!motivo) {
    return res.status(400).json({ erro: 'Motivo é obrigatório' });
  }

  try {
    const numeroTemporario =
      'TEMP-ASS-' + Date.now() + '-' + Math.floor(Math.random() * 100000);

    const r = await run(
      `INSERT INTO assistencias
       (numero, cliente_id, cliente_nome, motivo, fabricacao, observacao, anexo, empresa, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        numeroTemporario,
        Number(cliente_id),
        cliente_nome || '',
        motivo || '',
        fabricacao || '',
        observacao || '',
        anexo ? JSON.stringify(anexo) : null,
        emp,
        'aberto'
      ]
    );

    const ano = new Date().getFullYear();
    const numero = 'ASS-' + ano + '-' + String(r.id).padStart(4, '0');

    await run(
      'UPDATE assistencias SET numero = ? WHERE id = ?',
      [numero, r.id]
    );

    await run(`ALTER TABLE assistencia_itens ADD COLUMN IF NOT EXISTS cor_item TEXT DEFAULT ''`);

    for (const item of (itens || [])) {
      await run(
        `INSERT INTO assistencia_itens
         (assistencia_id, produto_codigo, produto_nome, cor_item, quantidade)
         VALUES (?,?,?,?,?)`,
        [
          r.id,
          item.produto_codigo || '',
          item.produto_nome || '',
          item.cor_item || '',
          Number(item.quantidade || 1)
        ]
      );
    }

    res.status(201).json({
      id: r.id,
      numero,
      mensagem: 'Assistência criada com sucesso'
    });
  } catch (e) {
    console.error('Erro ao criar assistência:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/assistencias/:id/status', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const r = await run(
      'UPDATE assistencias SET status = ? WHERE id = ? AND empresa = ?',
      [req.body.status, req.params.id, empresa]
    );

    if (!r.changes) {
      return res.status(404).json({ erro: 'Assistencia nao encontrada nesta empresa' });
    }

    res.json({ mensagem: 'Status atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/assistencias/:id', auth, async (req, res) => {
  const empresa = empresaDaRequisicao(req);

  try {
    const assistencia = await get(
      'SELECT id FROM assistencias WHERE id = ? AND empresa = ?',
      [req.params.id, empresa]
    );

    if (!assistencia) {
      return res.status(404).json({ erro: 'Assistencia nao encontrada nesta empresa' });
    }

    await run('DELETE FROM assistencia_itens WHERE assistencia_id = ?', [req.params.id]);
    await run('DELETE FROM assistencias WHERE id = ? AND empresa = ?', [req.params.id, empresa]);

    res.json({ mensagem: 'Assistência removida' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── AGENDA ──────────────────────────────────────────────────────────────────

app.get('/api/agenda', auth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT 
        a.*, 
        c.razao_social as cliente_nome
       FROM agenda a 
       LEFT JOIN clientes c ON c.id = a.cliente_id
       WHERE a.usuario_id = ?
       ORDER BY a.data, a.hora`,
      [req.usuario.id]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/agenda', auth, async (req, res) => {
  const { titulo, descricao, data, hora, tipo, cliente_id } = req.body;

  if (!titulo || !data) {
    return res.status(400).json({ erro: 'Título e data são obrigatórios' });
  }

  try {
    const r = await run(
      `INSERT INTO agenda 
      (titulo, descricao, data, hora, tipo, cliente_id, usuario_id) 
      VALUES (?,?,?,?,?,?,?)`,
      [
        titulo,
        descricao || '',
        data,
        hora || '',
        tipo || 'visita',
        cliente_id || null,
        req.usuario.id
      ]
    );

    res.status(201).json({
      id: r.id,
      mensagem: 'Evento criado'
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/agenda/:id', auth, async (req, res) => {
  try {
    await run(
      'UPDATE agenda SET status = ? WHERE id = ?',
      [req.body.status, req.params.id]
    );

    res.json({ mensagem: 'Evento atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/agenda/:id', auth, async (req, res) => {
  try {
    await run('DELETE FROM agenda WHERE id = ?', [req.params.id]);

    res.json({ mensagem: 'Evento removido' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── DEBUG / RECUPERAÇÃO ─────────────────────────────────────────────────────

app.get('/api/debug/clientes', async (req, res) => {
  try {
    const resumo = await query(`
      SELECT IFNULL(empresa, 'NULL') AS empresa,
             IFNULL(status, 'NULL') AS status,
             COUNT(*) AS total
      FROM clientes
      GROUP BY empresa, status
      ORDER BY empresa, status
    `);

    const total = await get('SELECT COUNT(*) AS total FROM clientes');

    const amostra = await query(`
      SELECT id, razao_social, empresa, status
      FROM clientes
      ORDER BY id DESC
      LIMIT 20
    `);

    res.json({ totalClientes: total?.total || 0, resumo, amostra });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
app.use(helmet());
// ─── 404 API ─────────────────────────────────────────────────────────────────

app.use('/api', (req, res) => {
  res.status(404).json({ erro: 'Rota de API não encontrada' });
});

// ─── START ───────────────────────────────────────────────────────────────────

garantirColunasProdutos().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ ERP rodando em http://localhost:${PORT}`);
    console.log('Banco de dados: PostgreSQL');
    console.log('Login: admin@kcnrepresentacoes.com.br');
    console.log('Senha: configurada no banco/PostgreSQL\n');
  });
});
