require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const { pool, query, get, run } = require('./database');

const app = express();

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
app.use(express.static(path.join(__dirname, 'public')));

console.log('Banco de dados: PostgreSQL');

function normalizarEmpresa(empresa) {
  const e = String(empresa || 'acp')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (e === 'acp') return 'acp';
  if (e === 'sleep') return 'sleep';
  if (e === 'tais' || e === 'thais') return 'tais';

  return 'acp';
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
  const empresa = normalizarEmpresa(req.query.empresa);

  try {
    const clientes = await get(
      `SELECT COUNT(*) as total 
       FROM clientes 
       WHERE status = 'ativo' AND empresa = ?`,
      [empresa]
    );

    const pedidos = await get(
      `SELECT COUNT(*) as total 
       FROM pedidos 
       WHERE empresa = ?`,
      [empresa]
    );

    const abertos = await get(
      `SELECT COUNT(*) as total 
       FROM pedidos 
       WHERE status = 'aberto' AND empresa = ?`,
      [empresa]
    );

    const faturamento = await get(
      `SELECT COALESCE(SUM(total), 0) as total 
       FROM pedidos 
       WHERE empresa = ?`,
      [empresa]
    );

    const ultimosPedidos = await query(
      `SELECT 
        p.id,
        p.numero,
        p.data_pedido,
        p.total,
        p.status,
        p.cor,
        c.razao_social as cliente_nome
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id
       WHERE p.empresa = ?
       ORDER BY p.id DESC
       LIMIT 5`,
      [empresa]
    );

    res.json({
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

// ─── CLIENTES ────────────────────────────────────────────────────────────────

app.get('/api/clientes', auth, async (req, res) => {
  const busca = req.query.busca ? `%${req.query.busca}%` : '%';
  const empresa = normalizarEmpresa(req.query.empresa);

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
  try {
    const row = await get('SELECT * FROM clientes WHERE id = ?', [req.params.id]);

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

  const emp = normalizarEmpresa(empresa);

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

  try {
    await run(
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
       WHERE id = ?`,
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
        normalizarEmpresa(empresa),
        codigo_origem || null,
        req.params.id
      ]
    );

    res.json({ mensagem: 'Cliente atualizado com sucesso' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/clientes/:id', auth, async (req, res) => {
  const clienteId = req.params.id;
  const empresa = normalizarEmpresa(req.query.empresa);
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
  const empresa = req.query.empresa ? normalizarEmpresa(req.query.empresa) : null;

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
        normalizarEmpresa(empresa)
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

  try {
    await run(
      `UPDATE produtos 
       SET codigo = ?, 
           descricao = ?, 
           unidade = ?, 
           preco_venda = ?, 
           estoque = ?,
           colecao_id = ?,
           empresa = ?
       WHERE id = ?`,
      [
        codigo,
        descricao,
        unidade || 'UN',
        Number(preco_venda || 0),
        Number(estoque || 0),
        Number(colecao_id || 0),
        normalizarEmpresa(empresa),
        req.params.id
      ]
    );

    res.json({ mensagem: 'Produto atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});


app.delete('/api/produtos/:id', auth, async (req, res) => {
  try {
    const produto = await get(
      'SELECT id FROM produtos WHERE id = ?',
      [req.params.id]
    );

    if (!produto) {
      return res.status(404).json({ erro: 'Produto não encontrado' });
    }

    await run(
      'UPDATE produtos SET status = ? WHERE id = ?',
      ['inativo', req.params.id]
    );

    res.json({ mensagem: 'Produto removido com sucesso' });
  } catch (e) {
    console.error('Erro ao remover produto:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── PEDIDOS ─────────────────────────────────────────────────────────────────

app.get('/api/pedidos', auth, async (req, res) => {
  const empresa = normalizarEmpresa(req.query.empresa);

  try {
    const rows = await query(
      `SELECT 
        p.*, 
        c.razao_social as cliente_nome, 
        u.nome as vendedor_nome
       FROM pedidos p
       JOIN clientes c ON c.id = p.cliente_id
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
       JOIN clientes c ON c.id = p.cliente_id
       WHERE p.id = ?`,
      [req.params.id]
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
    observacao,
    itens,
    empresa,
    cor
  } = req.body;

  if (!cliente_id || !itens?.length) {
    return res.status(400).json({ erro: 'Cliente e itens são obrigatórios' });
  }
const emp = normalizarEmpresa(empresa);

  const total = itens.reduce((acc, item) => {
    const quantidade = Number(item.quantidade || 0);
    const preco = Number(item.preco_unitario || 0);
    const desconto = Number(item.desconto || 0);

    return acc + (quantidade * preco * (1 - desconto / 100));
  }, 0);

  try {
    const numeroTemporario =
      'TEMP-PED-' + Date.now() + '-' + Math.floor(Math.random() * 100000);

    const r = await run(
      `INSERT INTO pedidos 
      (numero, cliente_id, vendedor_id, data_entrega, observacao, total, empresa, cor) 
      VALUES (?,?,?,?,?,?,?,?)`,
      [
        numeroTemporario,
        cliente_id,
        req.usuario.id,
        data_entrega || '',
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

    for (const item of itens) {
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
    observacao,
    itens,
    empresa,
    cor
  } = req.body;

  const pedidoId = req.params.id;
  const emp = normalizarEmpresa(empresa);

  if (!cliente_id || !itens || !itens.length) {
    return res.status(400).json({ erro: 'Cliente e itens são obrigatórios' });
  }

  const total = itens.reduce((acc, item) => {
    const quantidade = Number(item.quantidade || 0);
    const preco = Number(item.preco_unitario || 0);
    const desconto = Number(item.desconto || 0);

    return acc + (quantidade * preco * (1 - desconto / 100));
  }, 0);

  try {
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
           observacao = ?,
           total = ?,
           empresa = ?,
           cor = ?
       WHERE id = ?`,
      [
        cliente_id,
        data_entrega || '',
        observacao || '',
        total,
        emp,
        cor || null,
        pedidoId
      ]
    );

    await run('DELETE FROM pedido_itens WHERE pedido_id = ?', [pedidoId]);

    for (const item of itens) {
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
  try {
    await run(
      'UPDATE pedidos SET status = ? WHERE id = ?',
      [req.body.status, req.params.id]
    );

    res.json({ mensagem: 'Status atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/pedidos/:id', auth, async (req, res) => {
  const empresa = normalizarEmpresa(req.query.empresa);
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
    await run('DELETE FROM pedidos WHERE id = ?', [pedidoId]);

    res.json({ mensagem: 'Pedido removido com sucesso' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── ASSISTÊNCIAS ────────────────────────────────────────────────────────────

app.get('/api/assistencias', auth, async (req, res) => {
  const empresa = normalizarEmpresa(req.query.empresa);
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
  try {
    const assistencia = await get(
      'SELECT * FROM assistencias WHERE id = ?',
      [req.params.id]
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

  const emp = normalizarEmpresa(empresa);

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

    for (const item of (itens || [])) {
      await run(
        `INSERT INTO assistencia_itens
         (assistencia_id, produto_codigo, produto_nome, quantidade)
         VALUES (?,?,?,?)`,
        [
          r.id,
          item.produto_codigo || '',
          item.produto_nome || '',
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
  try {
    await run(
      'UPDATE assistencias SET status = ? WHERE id = ?',
      [req.body.status, req.params.id]
    );

    res.json({ mensagem: 'Status atualizado' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/assistencias/:id', auth, async (req, res) => {
  try {
    await run('DELETE FROM assistencia_itens WHERE assistencia_id = ?', [req.params.id]);
    await run('DELETE FROM assistencias WHERE id = ?', [req.params.id]);

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
