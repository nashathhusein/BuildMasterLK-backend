const pool = require('./db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS material_stock_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      material_id INT NOT NULL,
      project_id INT NULL,
      transaction_type ENUM('IN', 'OUT') NOT NULL,
      quantity DECIMAL(12,3) NOT NULL,
      unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      description VARCHAR(255) NULL,
      transaction_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_material_stock_material_date
        (material_id, transaction_date, id),
      INDEX idx_material_stock_project (project_id),
      CONSTRAINT fk_material_stock_material
        FOREIGN KEY (material_id) REFERENCES materials(id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_material_stock_project
        FOREIGN KEY (project_id) REFERENCES projects(id)
        ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  console.log('Material stock history table is ready.');
}

main()
  .catch(error => {
    console.error('Database error:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
