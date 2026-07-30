/** Aplica colunas empresa/codigo_origem e conta clientes ACP (uso manual se necessário). */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'erp.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run('ALTER TABLE clientes ADD COLUMN empresa TEXT', (err) => {
    if (err && !String(err.message).includes('duplicate column')) console.error(err.message);
  });
  db.run('ALTER TABLE clientes ADD COLUMN codigo_origem TEXT', (err) => {
    if (err && !String(err.message).includes('duplicate column')) console.error(err.message);
  });
  db.run(`UPDATE clientes SET empresa = 'geral' WHERE empresa IS NULL OR empresa = ''`, () => {
    db.get(`SELECT COUNT(*) as c FROM clientes WHERE empresa = 'acp'`, [], (e, row) => {
      console.log('Clientes ACP no banco:', row && row.c);
      db.close();
    });
  });
});