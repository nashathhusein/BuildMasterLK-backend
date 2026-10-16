
const pool = require('./db');

async function testDatabase() {
  try {
    const connection = await pool.getConnection();

    const [rows] = await connection.query(
      'SELECT DATABASE() AS database_name'
    );

    console.log('MySQL connection successful!');
    console.log('Database:', rows[0].database_name);

    connection.release();
  } catch (error) {
    console.error('MySQL connection failed:', error.message);
  } finally {
    await pool.end();
  }
}

testDatabase();
