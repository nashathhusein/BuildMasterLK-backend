
const mysql = require('mysql2/promise');
require('dotenv').config();

const isOnlineDatabase =
  process.env.DB_HOST &&
  process.env.DB_HOST !== 'localhost' &&
  process.env.DB_HOST !== '127.0.0.1';

const sslConfig =
  process.env.DB_SSL === 'true'
    ? {
      ca: process.env.DB_SSL_CA
        ? require('fs').readFileSync(process.env.DB_SSL_CA, 'utf8')
        : undefined,
      rejectUnauthorized: true,
    }
    : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'buildmaster_lk',

  ...(isOnlineDatabase && sslConfig
    ? { ssl: sslConfig }
    : {}),

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
