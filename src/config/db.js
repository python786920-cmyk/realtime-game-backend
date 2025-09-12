const mysql = require('mysql2/promise');

const dbConfig = {
  host: process.env.DB_HOST || 'cashearnersofficial.xyz',
  user: process.env.DB_USER || 'cztldhwx_Auto_PostTg',
  password: process.env.DB_PASSWORD || 'Aptap786920',
  database: process.env.DB_NAME || 'cztldhwx_Auto_PostTg'
};

const pool = mysql.createPool(dbConfig);

module.exports = pool;
