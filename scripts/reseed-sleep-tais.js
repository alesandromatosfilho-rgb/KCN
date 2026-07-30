/**
 * Remove todos os clientes Sleep e Taís do erp.db.
 * Depois execute: npm start — o servidor importa de novo os 44 registros em cada empresa.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'erp.db');
const db = new sqlite3.Database(dbPath);

db.run(`DELETE FROM clientes WHERE empresa IN ('sleep', 'tais')`, function (err) {
  if (err) console.error(err);
  else console.log('Removidos', this.changes, 'registros (sleep/taís). Reinicie o servidor.');
  db.close();
});