require('dotenv').config();
const pool = require('../db');
const bcrypt = require('bcrypt');
const readline = require('readline');

// Helper to prompt for input (hidden for password)
function prompt(question, hide = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (hide) {
      // Turn off echo for password
      const stdin = process.openStdin();
      process.stdin.on('data', char => {
        char = char + '';
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            stdin.pause();
            break;
          default:
            process.stdout.write('\x1B[2K\x1B[200D' + question + Array(rl.line.length + 1).join('*'));
            break;
        }
      });
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

(async () => {
  try {
    const name = process.env.ADMIN_NAME || (await prompt('Admin name: '));
    const email = process.env.ADMIN_EMAIL || (await prompt('Admin email: '));
    const password = process.env.ADMIN_PASSWORD || (await prompt('Admin password (hidden): ', true));

    if (!name || !email || !password) {
      console.error('All fields (name, email, password) are required.');
      process.exit(1);
    }

    // Check if admin already exists
    const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      console.log(`Admin user with email ${email} already exists (id=${existing.id}). No action taken.`);
      process.exit(0);
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const [result] = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', TRUE)`,
      [name, email, passwordHash]
    );
    console.log(`Admin user created with id ${result.insertId}.`);
  } catch (err) {
    console.error('Error creating admin user:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
