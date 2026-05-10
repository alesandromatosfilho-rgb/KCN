const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'erp.db');

const email = 'admin@kcnrepresentacoes.com.br';
const senha = 'KCN2026@Sistema';

const db = new sqlite3.Database(dbPath);

console.log('Banco usado:', dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      perfil TEXT DEFAULT 'vendedor',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const hash = bcrypt.hashSync(senha, 10);

  db.run(
    `DELETE FROM usuarios WHERE email IN (?, ?)`,
    ['admin@erp.com', email],
    function (err) {
      if (err) {
        console.error('Erro ao limpar usuários:', err.message);
        db.close();
        return;
      }

      db.run(
        `INSERT INTO usuarios (nome, email, senha, perfil)
         VALUES (?, ?, ?, ?)`,
        ['Administrador', email, hash, 'admin'],
        function (err) {
          if (err) {
            console.error('Erro ao criar admin:', err.message);
            db.close();
            return;
          }

          db.get(
            `SELECT id, nome, email, perfil, senha FROM usuarios WHERE email = ?`,
            [email],
            function (err, usuario) {
              if (err) {
                console.error('Erro ao verificar admin:', err.message);
              } else {
                console.log('Admin criado/verificado com sucesso!');
                console.log('Email:', email);
                console.log('Senha:', senha);
                console.log('Senha confere?', bcrypt.compareSync(senha, usuario.senha));
                console.table([{
                  id: usuario.id,
                  nome: usuario.nome,
                  email: usuario.email,
                  perfil: usuario.perfil
                }]);
              }

              db.close();
            }
          );
        }
      );
    }
  );
});