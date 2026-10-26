
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    success: true,
    app: 'BuildMaster LK',
    message: 'Construction Management API is running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    server: 'online'
  });
});

const PORT = process.env.PORT || 3000;
const pool = require('./db');

async function initializeAccountTransactionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NULL,
      transaction_type VARCHAR(20) NOT NULL,
      category VARCHAR(100) NOT NULL,
      description VARCHAR(255) NULL,
      amount DECIMAL(15, 2) NOT NULL,
      payment_method VARCHAR(50) NOT NULL,
      transaction_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_account_transactions_project
        FOREIGN KEY (project_id) REFERENCES projects(id)
        ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
}

async function initializePartyLedgerTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_account_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      transaction_type VARCHAR(30) NOT NULL,
      description VARCHAR(255) NULL,
      amount DECIMAL(15, 2) NOT NULL,
      payment_method VARCHAR(50) NULL,
      transaction_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer_account_transactions_customer_date
        (customer_id, transaction_date, id),
      CONSTRAINT fk_customer_account_transactions_customer
        FOREIGN KEY (customer_id) REFERENCES customers(id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS supplier_account_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      supplier_id INT NOT NULL,
      transaction_type VARCHAR(30) NOT NULL,
      description VARCHAR(255) NULL,
      amount DECIMAL(15, 2) NOT NULL,
      payment_method VARCHAR(50) NULL,
      transaction_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_supplier_account_transactions_supplier_date
        (supplier_id, transaction_date, id),
      CONSTRAINT fk_supplier_account_transactions_supplier
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);
}

async function initializeWorkerAttendanceTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      worker_id INT NOT NULL,
      project_id INT NOT NULL,
      attendance_date DATE NOT NULL,
      attendance_status ENUM('Present', 'Absent', 'Half Day') NOT NULL,
      daily_wage DECIMAL(12, 2) NOT NULL,
      overtime_hours DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
      overtime_rate DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
      calculated_wage DECIMAL(15, 2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_worker_attendance_worker_project_date
        (worker_id, project_id, attendance_date),
      INDEX idx_worker_attendance_date (attendance_date, id),
      CONSTRAINT fk_worker_attendance_worker
        FOREIGN KEY (worker_id) REFERENCES workers(id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT fk_worker_attendance_project
        FOREIGN KEY (project_id) REFERENCES projects(id)
        ON DELETE RESTRICT ON UPDATE CASCADE
    ) ENGINE=InnoDB
  `);

  const [[advanceColumn]] = await pool.query(
    `SELECT COUNT(*) AS column_count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'worker_attendance'
       AND COLUMN_NAME = 'wage_advance'`
  );
  if (Number(advanceColumn.column_count) === 0) {
    await pool.query(`
      ALTER TABLE worker_attendance
      ADD COLUMN wage_advance DECIMAL(15, 2) NOT NULL DEFAULT 0.00
      AFTER overtime_rate
    `);
  }
}

function parseOptionalText(value, field, maxLength) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    return { error: `${field} must be a string of at most ${maxLength} characters` };
  }
  return { value: value.trim() || null };
}

function parseMoney(value, allowZero) {
  if (
    typeof value !== 'number' &&
    !(typeof value === 'string' && value.trim() !== '')
  ) {
    return null;
  }

  const text = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match || match[1].length > 13) return null;

  const normalized = `${match[1]}.${(match[2] || '').padEnd(2, '0')}`;
  const cents = BigInt(match[1]) * 100n + BigInt(normalized.split('.')[1]);
  if ((!allowZero && cents === 0n) || cents > 999999999999999n) {
    return null;
  }
  return normalized;
}

function parsePositiveAmount(value) {
  return parseMoney(value, false);
}

function parseOpeningBalance(value) {
  if (value === undefined) return 0;
  return parseMoney(value, true);
}

function getValidPositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function parseStockQuantity(value) {
  const quantity = Number(value);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !/^\d+(\.\d{1,3})?$/.test(String(value).trim())
  ) {
    return null;
  }

  return quantity;
}

app.get('/api/materials', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        id,
        material_name,
        unit,
        quantity,
        unit_cost,
        (quantity * unit_cost) AS stock_value
      FROM materials
      ORDER BY material_name ASC
    `);

    res.json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Get materials error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch materials'
    });
  }
});

// Create a new construction material
app.post('/api/materials', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ success: false, message: 'Material details are required' });
  }

  const { material_name, unit, quantity, unit_cost } = body;

  if (typeof material_name !== 'string' || !material_name.trim() || material_name.trim().length > 150) {
    return res.status(400).json({ success: false, message: 'material_name is required and must be at most 150 characters' });
  }
  if (typeof unit !== 'string' || !unit.trim() || unit.trim().length > 30) {
    return res.status(400).json({ success: false, message: 'unit is required and must be at most 30 characters' });
  }

  // Validate quantity (allow 0, number or numeric string, up to 3 decimals)
  let qty;
  if (quantity !== undefined) {
    const q = Number(quantity);
    if (!Number.isFinite(q) || q < 0 || !/^\d+(?:\.\d{1,3})?$/.test(String(quantity).trim())) {
      return res.status(400).json({ success: false, message: 'quantity must be a non-negative number with up to 3 decimals' });
    }
    qty = q;
  } else {
    qty = 0;
  }

  // Validate unit_cost (allow 0, number or numeric string, up to 2 decimals)
  let cost;
  if (unit_cost !== undefined) {
    const c = Number(unit_cost);
    if (!Number.isFinite(c) || c < 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(unit_cost).trim())) {
      return res.status(400).json({ success: false, message: 'unit_cost must be a non-negative amount with at most two decimals' });
    }
    cost = c;
  } else {
    cost = 0;
  }
  if (qty === null) {
    return res.status(400).json({ success: false, message: 'quantity must be a non-negative number with up to 3 decimals' });
  }


  try {
    const [result] = await pool.query(
      `INSERT INTO materials (material_name, unit, quantity, unit_cost) VALUES (?, ?, ?, ?)`,
      [material_name.trim(), unit.trim(), qty, cost]
    );
    return res.status(201).json({ success: true, message: 'Material created successfully', id: result.insertId });
  } catch (error) {
    console.error('Create material error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to create material' });
  }
});


// Update an existing construction material
app.put('/api/materials/:id', async (req, res) => {
  const materialId = getValidPositiveId(req.params.id);

  if (materialId === null) {
    return res.status(400).json({
      success: false,
      message: 'Invalid material ID',
    });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'Material details are required',
    });
  }

  const { material_name, unit, quantity, unit_cost } = body;

  if (
    typeof material_name !== 'string' ||
    !material_name.trim() ||
    material_name.trim().length > 150
  ) {
    return res.status(400).json({
      success: false,
      message: 'Valid material name is required',
    });
  }

  if (
    typeof unit !== 'string' ||
    !unit.trim() ||
    unit.trim().length > 30
  ) {
    return res.status(400).json({
      success: false,
      message: 'Valid material unit is required',
    });
  }

  const qtyText = String(quantity ?? '').trim();
  const qty = Number(qtyText);

  if (
    qtyText === '' ||
    !Number.isFinite(qty) ||
    qty < 0 ||
    !/^\d+(?:\.\d{1,3})?$/.test(qtyText)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Quantity must be zero or a positive number with up to 3 decimals',
    });
  }

  const costText = String(unit_cost ?? '').trim();
  const cost = parseMoney(costText, true);

  if (cost === null) {
    return res.status(400).json({
      success: false,
      message: 'Unit cost must be zero or a positive amount with up to 2 decimals',
    });
  }

  try {
    const [result] = await pool.query(
      `UPDATE materials
       SET material_name = ?, unit = ?, quantity = ?, unit_cost = ?
       WHERE id = ?`,
      [material_name.trim(), unit.trim(), qty, cost, materialId],
    );

    if (result.affectedRows === 0) {
      const [rows] = await pool.query(
        'SELECT id FROM materials WHERE id = ?',
        [materialId],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Material not found',
        });
      }
    }

    const [rows] = await pool.query(
      `SELECT id, material_name, unit, quantity, unit_cost,
              (quantity * unit_cost) AS stock_value
       FROM materials
       WHERE id = ?`,
      [materialId],
    );

    return res.json({
      success: true,
      message: 'Material updated successfully',
      data: rows[0],
    });
  } catch (error) {
    console.error('Update material error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update material',
    });
  }
});


// Material Stock In / Stock Out API
app.post('/api/materials/:id/stock', async (req, res) => {
  const materialId = getValidPositiveId(req.params.id);
  if (materialId === null) {
    return res.status(400).json({ success: false, message: 'Invalid material ID' });
  }

  const { transaction_type, quantity, unit_cost, project_id, transaction_date, description } = req.body;

  if (transaction_type !== 'IN' && transaction_type !== 'OUT') {
    return res.status(400).json({ success: false, message: 'transaction_type must be "IN" or "OUT"' });
  }

  const qty = parseStockQuantity(quantity);
  if (qty === null) {
    return res.status(400).json({ success: false, message: 'Quantity must be a positive number with up to 3 decimals' });
  }

  const cost = parsePositiveAmount(unit_cost);
  if (cost === null) {
    return res.status(400).json({ success: false, message: 'unit_cost must be a positive amount with at most two decimals' });
  }

  const parsedProjectId = project_id !== undefined ? getValidPositiveId(project_id) : null;
  if (project_id !== undefined && parsedProjectId === null) {
    return res.status(400).json({ success: false, message: 'project_id must be a positive integer if provided' });
  }

  if (!isValidDate(transaction_date)) {
    return res.status(400).json({ success: false, message: 'transaction_date must be a valid date in YYYY-MM-DD format' });
  }

  const parsedDesc = parseOptionalText(description, 'Description', 255);
  if (parsedDesc.error) {
    return res.status(400).json({ success: false, message: parsedDesc.error });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [materialRows] = await connection.query('SELECT quantity FROM materials WHERE id = ? FOR UPDATE', [materialId]);
    if (materialRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    const currentQty = Number(materialRows[0].quantity);
    let newQty;
    if (transaction_type === 'IN') {
      newQty = currentQty + qty;
    } else {
      if (currentQty < qty) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'Insufficient stock for OUT transaction' });
      }
      newQty = currentQty - qty;
    }
    await connection.query('UPDATE materials SET quantity = ? WHERE id = ?', [newQty, materialId]);
    await connection.query(
      `INSERT INTO material_stock_transactions
        (material_id, project_id, transaction_type, quantity, unit_cost, description, transaction_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [materialId, parsedProjectId, transaction_type, qty, cost, parsedDesc.value, transaction_date]
    );
    await connection.commit();
    return res.json({ success: true, message: 'Stock updated', quantity: newQty });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Material stock transaction error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to process material stock transaction' });
  } finally {
    if (connection) connection.release();
  }
});

// Get material stock transaction history
app.get('/api/materials/:id/stock-history', async (req, res) => {
  const materialId = getValidPositiveId(req.params.id);
  if (materialId === null) {
    return res.status(400).json({ success: false, message: 'Invalid material ID' });
  }
  try {
    // Verify material exists
    const [materialRows] = await pool.query('SELECT id FROM materials WHERE id = ?', [materialId]);
    if (materialRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    // Fetch transaction history with optional project details
    const [historyRows] = await pool.query(
      `SELECT mst.id, mst.material_id, mst.project_id, p.project_name, mst.transaction_type, mst.quantity, mst.unit_cost, mst.description, mst.transaction_date
       FROM material_stock_transactions mst
       LEFT JOIN projects p ON p.id = mst.project_id
       WHERE mst.material_id = ?
       ORDER BY mst.transaction_date DESC, mst.id DESC`,
      [materialId]
    );
    return res.json({ success: true, count: historyRows.length, data: historyRows });
  } catch (error) {
    console.error('Material stock history error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch material stock history' });
  }
});

const customerBalancesSql = `
  SELECT
    customer_balances.*,
    GREATEST(customer_balances.net_balance, 0) AS outstanding_balance,
    GREATEST(-customer_balances.net_balance, 0) AS customer_advance
  FROM (
    SELECT
      c.id,
      c.name,
      c.phone,
      c.address,
      c.opening_balance,
      c.created_at,
      COALESCE(t.opening_ledger_total, 0) AS opening_ledger_total,
      COALESCE(t.credit_sales_total, 0) AS credit_sales_total,
      COALESCE(t.payments_received_total, 0) AS payments_received_total,
      COALESCE(t.credits_refunds_total, 0) AS credits_refunds_total,
      COALESCE(c.opening_balance, 0)
        + COALESCE(t.opening_ledger_total, 0)
        + COALESCE(t.credit_sales_total, 0)
        - COALESCE(t.payments_received_total, 0)
        - COALESCE(t.credits_refunds_total, 0) AS net_balance
    FROM customers c
    LEFT JOIN (
      SELECT
        customer_id,
        SUM(CASE WHEN transaction_type = 'OpeningBalance' THEN amount ELSE 0 END)
          AS opening_ledger_total,
        SUM(CASE
          WHEN transaction_type IN ('CreditSale', 'CreditService') THEN amount
          ELSE 0
        END) AS credit_sales_total,
        SUM(CASE
          WHEN transaction_type = 'PaymentReceived' THEN amount
          ELSE 0
        END) AS payments_received_total,
        SUM(CASE
          WHEN transaction_type IN ('CreditNote', 'RefundIssued') THEN amount
          ELSE 0
        END) AS credits_refunds_total
      FROM customer_account_transactions
      GROUP BY customer_id
    ) t ON t.customer_id = c.id
  ) customer_balances
`;

const supplierBalancesSql = `
  SELECT
    s.id, s.name, s.phone, s.address, s.opening_balance, s.created_at,
    COALESCE(t.credit_purchases_total, 0) AS credit_purchases_total,
    COALESCE(t.payments_made_total, 0) AS payments_made_total,
    COALESCE(t.credit_notes_total, 0) AS credit_notes_total,
    COALESCE(s.opening_balance, 0)
      + COALESCE(t.opening_ledger_total, 0)
      + COALESCE(t.credit_purchases_total, 0)
      - COALESCE(t.payments_made_total, 0)
      - COALESCE(t.credit_notes_total, 0) AS outstanding_balance
  FROM suppliers s
  LEFT JOIN (
    SELECT
      supplier_id,
      SUM(CASE WHEN transaction_type = 'OpeningBalance' THEN amount ELSE 0 END)
        AS opening_ledger_total,
      SUM(CASE WHEN transaction_type = 'CreditPurchase' THEN amount ELSE 0 END)
        AS credit_purchases_total,
      SUM(CASE WHEN transaction_type = 'PaymentMade' THEN amount ELSE 0 END)
        AS payments_made_total,
      SUM(CASE WHEN transaction_type = 'SupplierCreditNote' THEN amount ELSE 0 END)
        AS credit_notes_total
    FROM supplier_account_transactions
    GROUP BY supplier_id
  ) t ON t.supplier_id = s.id
`;

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

app.get('/api/accounts/summary', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END), 0)
          AS total_income,
        COALESCE(SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END), 0)
          AS total_expenses
      FROM account_transactions
    `);
    const [[customerRows], [supplierRows]] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(outstanding_balance), 0) AS customer_receivables,
          COALESCE(SUM(customer_advance), 0) AS customer_advances
        FROM (${customerBalancesSql}) customer_balances
      `),
      pool.query(`
        SELECT COALESCE(SUM(GREATEST(outstanding_balance, 0)), 0)
          AS supplier_payables
        FROM (${supplierBalancesSql}) supplier_balances
      `)
    ]);

    const totalIncome = Number(rows[0].total_income);
    const totalExpenses = Number(rows[0].total_expenses);

    return res.json({
      success: true,
      data: {
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_balance: totalIncome - totalExpenses,
        customer_due: customerRows[0].customer_receivables,
        customer_advance: customerRows[0].customer_advances,
        supplier_payable: supplierRows[0].supplier_payables
      }
    });
  } catch (error) {
    console.error('Accounts summary error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch accounts summary'
    });
  }
});

function registerPartyAccountRoutes({
  path,
  table,
  ledgerTable,
  idColumn,
  balancesSql,
  creditType,
  paymentType,
  additionalTransactionTypes = [],
  label
}) {
  app.get(path, async (req, res) => {
    try {
      const [parties] = await pool.query(
        `${balancesSql} ORDER BY name ASC`
      );
      return res.json({
        success: true,
        count: parties.length,
        data: parties
      });
    } catch (error) {
      console.error(`List ${label} accounts error:`, error.message);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch ${label} accounts`
      });
    }
  });

  app.post(path, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: `${label} details are required`
      });
    }

    const { name, phone, address, opening_balance } = body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) {
      return res.status(400).json({
        success: false,
        message: 'Name is required and must be at most 150 characters'
      });
    }

    const parsedPhone = parseOptionalText(phone, 'Phone', 30);
    const parsedAddress = parseOptionalText(address, 'Address', 65535);
    const openingBalance = parseOpeningBalance(opening_balance);
    if (parsedPhone.error || parsedAddress.error || openingBalance === null) {
      return res.status(400).json({
        success: false,
        message:
          parsedPhone.error ||
          parsedAddress.error ||
          'Opening balance must be a non-negative amount with at most two decimals'
      });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [result] = await connection.query(
        `INSERT INTO ${table} (name, phone, address, opening_balance)
         VALUES (?, ?, ?, 0)`,
        [name.trim(), parsedPhone.value, parsedAddress.value]
      );

      if (openingBalance > 0) {
        await connection.query(
          `INSERT INTO ${ledgerTable}
           (${idColumn}, transaction_type, description, amount,
            payment_method, transaction_date)
           VALUES (?, 'OpeningBalance', 'Opening balance', ?, NULL, ?)`,
          [
            result.insertId,
            typeof openingBalance === 'number'
              ? openingBalance.toFixed(2)
              : openingBalance,
            new Date().toISOString().slice(0, 10)
          ]
        );
      }

      await connection.commit();
      return res.status(201).json({
        success: true,
        message: `${label} account created successfully`,
        id: result.insertId
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error(`Create ${label} account error:`, error.message);
      return res.status(500).json({
        success: false,
        message: `Failed to create ${label} account`
      });
    } finally {
      if (connection) connection.release();
    }
  });

  app.get(`${path}/:id`, async (req, res) => {
    const id = getValidPositiveId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${label} ID`
      });
    }

    try {
      const [parties] = await pool.query(`${balancesSql} WHERE id = ?`, [id]);
      if (parties.length === 0) {
        return res.status(404).json({
          success: false,
          message: `${label} not found`
        });
      }

      const [transactions] = await pool.query(
        `SELECT * FROM ${ledgerTable}
         WHERE ${idColumn} = ?
         ORDER BY transaction_date DESC, id DESC`,
        [id]
      );
      return res.json({
        success: true,
        data: {
          ...parties[0],
          transactions
        }
      });
    } catch (error) {
      console.error(`Get ${label} account error:`, error.message);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch ${label} account`
      });
    }
  });

  app.put(`${path}/:id`, async (req, res) => {
    const id = getValidPositiveId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${label} ID`
      });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: `${label} details are required`
      });
    }

    const { name, phone, address } = body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) {
      return res.status(400).json({
        success: false,
        message: 'Name is required and must be at most 150 characters'
      });
    }
    const parsedPhone = parseOptionalText(phone, 'Phone', 30);
    const parsedAddress = parseOptionalText(address, 'Address', 65535);
    if (parsedPhone.error || parsedAddress.error) {
      return res.status(400).json({
        success: false,
        message: parsedPhone.error || parsedAddress.error
      });
    }

    try {
      const [result] = await pool.query(
        `UPDATE ${table} SET name = ?, phone = ?, address = ? WHERE id = ?`,
        [name.trim(), parsedPhone.value, parsedAddress.value, id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: `${label} not found`
        });
      }
      return res.json({
        success: true,
        message: `${label} account updated successfully`
      });
    } catch (error) {
      console.error(`Update ${label} account error:`, error.message);
      return res.status(500).json({
        success: false,
        message: `Failed to update ${label} account`
      });
    }
  });

  app.get(`${path}/:id/transactions`, async (req, res) => {
    const id = getValidPositiveId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${label} ID`
      });
    }

    try {
      const [parties] = await pool.query(
        `SELECT id FROM ${table} WHERE id = ?`,
        [id]
      );
      if (parties.length === 0) {
        return res.status(404).json({
          success: false,
          message: `${label} not found`
        });
      }
      const [transactions] = await pool.query(
        `SELECT * FROM ${ledgerTable}
         WHERE ${idColumn} = ?
         ORDER BY transaction_date DESC, id DESC`,
        [id]
      );
      return res.json({
        success: true,
        count: transactions.length,
        data: transactions
      });
    } catch (error) {
      console.error(`List ${label} transactions error:`, error.message);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch ${label} transactions`
      });
    }
  });

  app.post(`${path}/:id/transactions`, async (req, res) => {
    const id = getValidPositiveId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${label} ID`
      });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction details are required'
      });
    }

    const { transaction_type, description, amount, payment_method, transaction_date } = body;
    const validTransactionTypes = [
      creditType,
      paymentType,
      ...additionalTransactionTypes
    ];
    if (!validTransactionTypes.includes(transaction_type)) {
      return res.status(400).json({
        success: false,
        message: `Transaction type must be one of: ${validTransactionTypes.join(', ')}`
      });
    }
    const parsedAmount = parsePositiveAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be positive and have at most two decimals'
      });
    }
    const parsedDescription = parseOptionalText(description, 'Description', 255);
    const parsedPaymentMethod = parseOptionalText(
      payment_method,
      'Payment method',
      50
    );
    if (parsedDescription.error || parsedPaymentMethod.error) {
      return res.status(400).json({
        success: false,
        message: parsedDescription.error || parsedPaymentMethod.error
      });
    }
    if (
      (transaction_type === paymentType || transaction_type === 'RefundIssued') &&
      !parsedPaymentMethod.value
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment method is required for a payment or refund'
      });
    }
    if (
      label === 'Supplier' &&
      transaction_type === paymentType &&
      !['Cash', 'Bank Transfer', 'Cheque'].includes(parsedPaymentMethod.value)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Supplier payment method must be Cash, Bank Transfer, or Cheque'
      });
    }
    if (!isValidDate(transaction_date)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction date must be a valid date in YYYY-MM-DD format'
      });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [parties] = await connection.query(
        `SELECT id FROM ${table} WHERE id = ? FOR UPDATE`,
        [id]
      );
      if (parties.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: `${label} not found`
        });
      }

      if (label === 'Supplier' && transaction_type === paymentType) {
        const [balances] = await connection.query(
          `SELECT outstanding_balance
           FROM (${balancesSql}) supplier_balances
           WHERE id = ?`,
          [id]
        );
        const balanceMatch = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(
          String(balances[0].outstanding_balance)
        );
        if (!balanceMatch) {
          throw new Error('Supplier payable balance is not a valid decimal amount');
        }
        const balanceCents =
          (BigInt(balanceMatch[2]) * 100n +
            BigInt((balanceMatch[3] || '').padEnd(2, '0'))) *
          (balanceMatch[1] === '-' ? -1n : 1n);
        const [paymentWhole, paymentFraction] = parsedAmount.split('.');
        const paymentCents =
          BigInt(paymentWhole) * 100n + BigInt(paymentFraction);
        if (paymentCents > balanceCents) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: 'Payment exceeds the current supplier payable balance'
          });
        }
      }

      const [result] = await connection.query(
        `INSERT INTO ${ledgerTable}
         (${idColumn}, transaction_type, description, amount,
          payment_method, transaction_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          transaction_type,
          parsedDescription.value,
          parsedAmount,
          parsedPaymentMethod.value,
          transaction_date
        ]
      );
      await connection.commit();
      return res.status(201).json({
        success: true,
        message: `${label} transaction recorded successfully`,
        transaction_id: result.insertId
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error(`Create ${label} transaction error:`, error.message);
      return res.status(500).json({
        success: false,
        message: `Failed to record ${label} transaction`
      });
    } finally {
      if (connection) connection.release();
    }
  });
}

registerPartyAccountRoutes({
  path: '/api/accounts/customers',
  table: 'customers',
  ledgerTable: 'customer_account_transactions',
  idColumn: 'customer_id',
  balancesSql: customerBalancesSql,
  creditType: 'CreditSale',
  paymentType: 'PaymentReceived',
  additionalTransactionTypes: [
    'CreditService',
    'CreditNote',
    'RefundIssued'
  ],
  label: 'Customer'
});

registerPartyAccountRoutes({
  path: '/api/accounts/suppliers',
  table: 'suppliers',
  ledgerTable: 'supplier_account_transactions',
  idColumn: 'supplier_id',
  balancesSql: supplierBalancesSql,
  creditType: 'CreditPurchase',
  paymentType: 'PaymentMade',
  additionalTransactionTypes: ['SupplierCreditNote'],
  label: 'Supplier'
});

app.get('/api/customers', async (req, res) => {
  try {
    const [customers] = await pool.query(
      `${customerBalancesSql} ORDER BY name ASC`
    );
    return res.json({
      success: true,
      count: customers.length,
      data: customers
    });
  } catch (error) {
    console.error('List customers error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch customers'
    });
  }
});

app.get('/api/suppliers', async (req, res) => {
  try {
    const [suppliers] = await pool.query(
      `${supplierBalancesSql} ORDER BY name ASC`
    );
    return res.json({
      success: true,
      count: suppliers.length,
      data: suppliers
    });
  } catch (error) {
    console.error('List suppliers error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch suppliers'
    });
  }
});

app.get('/api/reports/projects/:id', async (req, res) => {
  const projectId = getValidPositiveId(req.params.id);
  if (projectId === null) {
    return res.status(400).json({
      success: false,
      message: 'Invalid project ID'
    });
  }

  const { start_date: startDate, end_date: endDate } = req.query;
  if (
    (startDate !== undefined && !isValidDate(startDate)) ||
    (endDate !== undefined && !isValidDate(endDate))
  ) {
    return res.status(400).json({
      success: false,
      message: 'Date filters must use a valid YYYY-MM-DD date'
    });
  }
  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({
      success: false,
      message: 'Start date must be on or before end date'
    });
  }

  const dateConditions = [];
  const dateValues = [];
  if (startDate) {
    dateConditions.push('transaction_date >= ?');
    dateValues.push(startDate);
  }
  if (endDate) {
    dateConditions.push('transaction_date <= ?');
    dateValues.push(endDate);
  }
  const dateFilter = dateConditions.length
    ? ` AND ${dateConditions.join(' AND ')}`
    : '';
  const attendanceDateConditions = [];
  const attendanceDateValues = [];
  if (startDate) {
    attendanceDateConditions.push('attendance_date >= ?');
    attendanceDateValues.push(startDate);
  }
  if (endDate) {
    attendanceDateConditions.push('attendance_date <= ?');
    attendanceDateValues.push(endDate);
  }
  const attendanceDateFilter = attendanceDateConditions.length
    ? ` AND ${attendanceDateConditions.join(' AND ')}`
    : '';

  try {
    const [projectRows] = await pool.query(
      'SELECT id, project_name FROM projects WHERE id = ?',
      [projectId]
    );
    if (projectRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const [[totals]] = await pool.query(
      `SELECT
         COUNT(*) AS transaction_count,
         COALESCE(SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END), 0)
           AS total_income,
         COALESCE(SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END), 0)
           AS total_expenses,
         COALESCE(SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END), 0)
           AS net_result
       FROM account_transactions
       WHERE project_id = ?${dateFilter}`,
      [projectId, ...dateValues]
    );
    const [[labourCosts]] = await pool.query(
      `SELECT
         COUNT(*) AS attendance_count,
         COALESCE(SUM(calculated_wage), 0) AS total_labour_cost,
         COALESCE(SUM(wage_advance), 0) AS total_wage_advances,
         COALESCE(SUM(calculated_wage - wage_advance), 0) AS remaining_wage_balance
       FROM worker_attendance
       WHERE project_id = ?${attendanceDateFilter}`,
      [projectId, ...attendanceDateValues]
    );
    const [transactions] = await pool.query(
      `SELECT id, project_id, transaction_type, category, description,
              amount, payment_method,
              DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date
       FROM account_transactions
       WHERE project_id = ?${dateFilter}
       ORDER BY transaction_date DESC, id DESC`,
      [projectId, ...dateValues]
    );
    const [[unallocated]] = await pool.query(
      `SELECT
         COUNT(*) AS transaction_count,
         COALESCE(SUM(CASE WHEN transaction_type = 'Income' THEN amount ELSE 0 END), 0)
           AS total_income,
         COALESCE(SUM(CASE WHEN transaction_type = 'Expense' THEN amount ELSE 0 END), 0)
           AS total_expenses
       FROM account_transactions
       WHERE project_id IS NULL${dateFilter}`,
      dateValues
    );
    const [unallocatedTransactions] = await pool.query(
      `SELECT id, project_id, transaction_type, category, description,
              amount, payment_method,
              DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date
       FROM account_transactions
       WHERE project_id IS NULL${dateFilter}
       ORDER BY transaction_date DESC, id DESC`,
      dateValues
    );

    return res.json({
      success: true,
      data: {
        project: projectRows[0],
        labour_costs: labourCosts,
        summary: {
          transaction_count: totals.transaction_count,
          total_income: totals.total_income,
          total_expenses: totals.total_expenses,
          net_result: totals.net_result
        },
        unallocated: {
          ...unallocated,
          transactions: unallocatedTransactions
        },
        transactions
      }
    });
  } catch (error) {
    console.error('Project report error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch project report'
    });
  }
});

app.get('/api/accounts/transactions', async (req, res) => {
  try {
    const [transactions] = await pool.query(`
      SELECT
        account_transactions.*,
        projects.project_name
      FROM account_transactions
      LEFT JOIN projects ON projects.id = account_transactions.project_id
      ORDER BY account_transactions.transaction_date DESC,
               account_transactions.id DESC
    `);

    return res.json({
      success: true,
      count: transactions.length,
      data: transactions
    });
  } catch (error) {
    console.error('Accounts transactions error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch account transactions'
    });
  }
});

app.put('/api/accounts/transactions/:id/project', async (req, res) => {
  const transactionId = getValidPositiveId(req.params.id);
  if (transactionId === null) {
    return res.status(400).json({
      success: false,
      message: 'Invalid transaction ID'
    });
  }

  const body = req.body;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.prototype.hasOwnProperty.call(body, 'project_id')
  ) {
    return res.status(400).json({
      success: false,
      message: 'Project ID is required; use null to remove the allocation'
    });
  }

  const { project_id: projectIdValue } = body;
  if (
    projectIdValue !== null &&
    (!Number.isSafeInteger(Number(projectIdValue)) || Number(projectIdValue) < 1)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Project ID must be a positive integer or null'
    });
  }
  const projectId = projectIdValue === null ? null : Number(projectIdValue);

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [transactions] = await connection.query(
      'SELECT id FROM account_transactions WHERE id = ? FOR UPDATE',
      [transactionId]
    );
    if (transactions.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    if (projectId !== null) {
      const [projects] = await connection.query(
        'SELECT id FROM projects WHERE id = ?',
        [projectId]
      );
      if (projects.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'Project not found'
        });
      }
    }

    await connection.query(
      'UPDATE account_transactions SET project_id = ? WHERE id = ?',
      [projectId, transactionId]
    );
    await connection.commit();
    return res.json({
      success: true,
      message: 'Transaction project allocation updated successfully'
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Update transaction project allocation error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update transaction project allocation'
    });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/accounts/transactions', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'A transaction object is required'
    });
  }

  const {
    project_id,
    transaction_type,
    category,
    description,
    amount,
    payment_method,
    transaction_date
  } = body;

  if (!['Income', 'Expense'].includes(transaction_type)) {
    return res.status(400).json({
      success: false,
      message: 'Transaction type must be Income or Expense'
    });
  }

  if (typeof category !== 'string' || !category.trim() || category.trim().length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Category is required and must be at most 100 characters'
    });
  }

  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== 'string' || description.length > 255)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Description must be at most 255 characters'
    });
  }

  if (
    typeof payment_method !== 'string' ||
    !payment_method.trim() ||
    payment_method.trim().length > 50
  ) {
    return res.status(400).json({
      success: false,
      message: 'Payment method is required and must be at most 50 characters'
    });
  }

  if (!isValidDate(transaction_date)) {
    return res.status(400).json({
      success: false,
      message: 'Transaction date must be a valid date in YYYY-MM-DD format'
    });
  }

  if (
    (typeof amount !== 'number' &&
      !(typeof amount === 'string' && amount.trim() !== '')) ||
    !Number.isFinite(Number(amount)) ||
    Number(amount) <= 0 ||
    Number(amount) > 9999999999999.99 ||
    Math.round(Number(amount) * 100) !== Number(amount) * 100
  ) {
    return res.status(400).json({
      success: false,
      message: 'Amount must be a positive number with at most two decimals'
    });
  }

  if (
    project_id !== undefined &&
    project_id !== null &&
    (!Number.isSafeInteger(Number(project_id)) || Number(project_id) < 1)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Project ID must be a positive integer or null'
    });
  }

  const projectId = project_id == null ? null : Number(project_id);

  try {
    if (projectId !== null) {
      const [projects] = await pool.query(
        'SELECT id FROM projects WHERE id = ?',
        [projectId]
      );

      if (projects.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Project not found'
        });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO account_transactions
       (project_id, transaction_type, category, description, amount,
        payment_method, transaction_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        transaction_type,
        category.trim(),
        description?.trim() || null,
        Number(amount),
        payment_method.trim(),
        transaction_date
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Transaction added successfully',
      transaction_id: result.insertId
    });
  } catch (error) {
    console.error('Create account transaction error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to add account transaction'
    });
  }
});

app.get('/api/workers', async (req, res) => {
  try {
    const [workers] = await pool.query(
      `SELECT id, name, phone, job_role, daily_wage, is_active, created_at
       FROM workers
       ORDER BY is_active DESC, name ASC, id ASC`
    );
    return res.json({
      success: true,
      count: workers.length,
      data: workers
    });
  } catch (error) {
    console.error('List workers error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workers'
    });
  }
});

app.post('/api/workers', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'Worker details are required'
    });
  }

  const { name, phone, job_role, daily_wage } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) {
    return res.status(400).json({
      success: false,
      message: 'Worker name is required and must be at most 150 characters'
    });
  }
  const parsedPhone = parseOptionalText(phone, 'Phone', 30);
  const parsedJobRole = parseOptionalText(job_role, 'Job role', 100);
  const parsedDailyWage = parseMoney(daily_wage === undefined ? 0 : daily_wage, true);
  if (parsedPhone.error || parsedJobRole.error || parsedDailyWage === null) {
    return res.status(400).json({
      success: false,
      message:
        parsedPhone.error ||
        parsedJobRole.error ||
        'Daily wage must be a non-negative amount with at most two decimals'
    });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO workers (name, phone, job_role, daily_wage, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [name.trim(), parsedPhone.value, parsedJobRole.value, parsedDailyWage]
    );
    return res.status(201).json({
      success: true,
      message: 'Worker added successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('Create worker error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to add worker'
    });
  }
});

app.put('/api/workers/:id', async (req, res) => {
  const id = getValidPositiveId(req.params.id);
  if (id === null) {
    return res.status(400).json({
      success: false,
      message: 'Invalid worker ID'
    });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'Worker details are required'
    });
  }
  const { name, phone, job_role, daily_wage } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) {
    return res.status(400).json({
      success: false,
      message: 'Worker name is required and must be at most 150 characters'
    });
  }
  const parsedPhone = parseOptionalText(phone, 'Phone', 30);
  const parsedJobRole = parseOptionalText(job_role, 'Job role', 100);
  const parsedDailyWage = parseMoney(daily_wage, true);
  if (parsedPhone.error || parsedJobRole.error || parsedDailyWage === null) {
    return res.status(400).json({
      success: false,
      message:
        parsedPhone.error ||
        parsedJobRole.error ||
        'Daily wage must be a non-negative amount with at most two decimals'
    });
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM workers WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Worker not found'
      });
    }
    await pool.query(
      `UPDATE workers
       SET name = ?, phone = ?, job_role = ?, daily_wage = ?
       WHERE id = ?`,
      [name.trim(), parsedPhone.value, parsedJobRole.value, parsedDailyWage, id]
    );
    return res.json({
      success: true,
      message: 'Worker details updated successfully'
    });
  } catch (error) {
    console.error('Update worker error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update worker'
    });
  }
});

app.patch('/api/workers/:id/status', async (req, res) => {
  const id = getValidPositiveId(req.params.id);
  if (id === null) {
    return res.status(400).json({
      success: false,
      message: 'Invalid worker ID'
    });
  }
  const { is_active: isActive } = req.body || {};
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'Worker active status must be true or false'
    });
  }

  try {
    const [result] = await pool.query(
      'UPDATE workers SET is_active = ? WHERE id = ?',
      [isActive ? 1 : 0, id]
    );
    if (result.affectedRows === 0) {
      const [existing] = await pool.query(
        'SELECT id FROM workers WHERE id = ?',
        [id]
      );
      if (existing.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Worker not found'
        });
      }
    }
    return res.json({
      success: true,
      message: isActive
        ? 'Worker activated successfully'
        : 'Worker deactivated successfully'
    });
  } catch (error) {
    console.error('Update worker status error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update worker status'
    });
  }
});

app.get('/api/worker-attendance', async (req, res) => {
  const { attendance_date: attendanceDate } = req.query;
  const workerId =
    req.query.worker_id === undefined
      ? null
      : typeof req.query.worker_id === 'string'
        ? getValidPositiveId(req.query.worker_id)
        : null;
  const projectId =
    req.query.project_id === undefined
      ? null
      : typeof req.query.project_id === 'string'
        ? getValidPositiveId(req.query.project_id)
        : null;

  if (
    (req.query.worker_id !== undefined && workerId === null) ||
    (req.query.project_id !== undefined && projectId === null) ||
    (attendanceDate !== undefined && !isValidDate(attendanceDate))
  ) {
    return res.status(400).json({
      success: false,
      message:
        'Attendance filters require positive worker/project IDs and a valid YYYY-MM-DD date'
    });
  }

  const filters = [];
  const filterValues = [];
  if (attendanceDate !== undefined) {
    filters.push('worker_attendance.attendance_date = ?');
    filterValues.push(attendanceDate);
  }
  if (workerId !== null) {
    filters.push('worker_attendance.worker_id = ?');
    filterValues.push(workerId);
  }
  if (projectId !== null) {
    filters.push('worker_attendance.project_id = ?');
    filterValues.push(projectId);
  }
  const filterClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const [records] = await pool.query(
      `SELECT worker_attendance.id, worker_attendance.worker_id,
              worker_attendance.project_id,
              DATE_FORMAT(worker_attendance.attendance_date, '%Y-%m-%d')
                AS attendance_date,
              worker_attendance.attendance_status, worker_attendance.daily_wage,
              worker_attendance.overtime_hours, worker_attendance.overtime_rate,
              worker_attendance.calculated_wage, worker_attendance.wage_advance,
              worker_attendance.calculated_wage - worker_attendance.wage_advance
                AS wage_balance,
              workers.name AS worker_name,
              projects.project_name
       FROM worker_attendance
       INNER JOIN workers ON workers.id = worker_attendance.worker_id
       INNER JOIN projects ON projects.id = worker_attendance.project_id
       ${filterClause}
       ORDER BY worker_attendance.attendance_date DESC, worker_attendance.id DESC`,
      filterValues
    );
    return res.json({
      success: true,
      count: records.length,
      data: records
    });
  } catch (error) {
    console.error('List worker attendance error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch worker attendance'
    });
  }
});

app.post('/api/worker-attendance', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'Attendance details are required'
    });
  }

  const workerId = getValidPositiveId(body.worker_id);
  const projectId = getValidPositiveId(body.project_id);
  const attendanceDate = body.attendance_date;
  const attendanceStatus = body.attendance_status;
  const hoursText = String(body.overtime_hours ?? '');
  const hoursMatch = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(hoursText);
  const overtimeRate = parseMoney(body.overtime_rate, true);
  const wageAdvance = parseMoney(
    body.wage_advance === undefined ? 0 : body.wage_advance,
    true
  );

  if (workerId === null || projectId === null) {
    return res.status(400).json({
      success: false,
      message: 'Select a valid worker and project'
    });
  }
  if (
    typeof attendanceDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate) ||
    Number.isNaN(Date.parse(`${attendanceDate}T00:00:00Z`)) ||
    new Date(`${attendanceDate}T00:00:00Z`).toISOString().slice(0, 10) !==
    attendanceDate
  ) {
    return res.status(400).json({
      success: false,
      message: 'Attendance date must be a valid date in YYYY-MM-DD format'
    });
  }
  if (!['Present', 'Absent', 'Half Day'].includes(attendanceStatus)) {
    return res.status(400).json({
      success: false,
      message: 'Attendance status must be Present, Absent, or Half Day'
    });
  }
  if (hoursMatch === null || overtimeRate === null || wageAdvance === null) {
    return res.status(400).json({
      success: false,
      message:
        'Overtime hours, rate, and wage advance must be valid non-negative amounts'
    });
  }

  const hoursHundredths =
    BigInt(hoursMatch[1]) * 100n + BigInt((hoursMatch[2] || '').padEnd(2, '0'));
  if (attendanceStatus === 'Absent' && hoursHundredths > 0n) {
    return res.status(400).json({
      success: false,
      message: 'Overtime hours must be zero when attendance is Absent'
    });
  }

  try {
    const [[worker]] = await pool.query(
      'SELECT daily_wage, is_active FROM workers WHERE id = ?',
      [workerId]
    );
    if (!worker) {
      return res.status(404).json({
        success: false,
        message: 'Worker not found'
      });
    }
    if (!worker.is_active) {
      return res.status(400).json({
        success: false,
        message: 'Attendance can only be recorded for active workers'
      });
    }
    const [[project]] = await pool.query(
      'SELECT id FROM projects WHERE id = ?',
      [projectId]
    );
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const dailyWage = parseMoney(worker.daily_wage ?? 0, true);
    const dailyWageCents =
      BigInt(dailyWage.split('.')[0]) * 100n + BigInt(dailyWage.split('.')[1]);
    const rateParts = overtimeRate.split('.');
    const rateCents = BigInt(rateParts[0]) * 100n + BigInt(rateParts[1]);
    const baseWageCents =
      attendanceStatus === 'Present'
        ? dailyWageCents
        : attendanceStatus === 'Half Day'
          ? (dailyWageCents + 1n) / 2n
          : 0n;
    const overtimeCents = (hoursHundredths * rateCents + 50n) / 100n;
    const calculatedWageCents = baseWageCents + overtimeCents;
    if (calculatedWageCents > 999999999999999n) {
      return res.status(400).json({
        success: false,
        message: 'Calculated wage exceeds the supported amount'
      });
    }
    const calculatedWage = `${calculatedWageCents / 100n}.${String(
      calculatedWageCents % 100n
    ).padStart(2, '0')}`;
    const wageAdvanceParts = wageAdvance.split('.');
    const wageAdvanceCents =
      BigInt(wageAdvanceParts[0]) * 100n + BigInt(wageAdvanceParts[1]);
    const wageBalanceCents = calculatedWageCents - wageAdvanceCents;
    const wageBalanceAbsolute =
      wageBalanceCents < 0n ? -wageBalanceCents : wageBalanceCents;
    const wageBalance = `${wageBalanceCents < 0n ? '-' : ''}${wageBalanceAbsolute / 100n
      }.${String(wageBalanceAbsolute % 100n).padStart(2, '0')}`;

    const [result] = await pool.query(
      `INSERT INTO worker_attendance
       (worker_id, project_id, attendance_date, attendance_status, daily_wage,
        overtime_hours, overtime_rate, wage_advance, calculated_wage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workerId,
        projectId,
        attendanceDate,
        attendanceStatus,
        dailyWage,
        `${hoursHundredths / 100n}.${String(hoursHundredths % 100n).padStart(2, '0')}`,
        overtimeRate,
        wageAdvance,
        calculatedWage
      ]
    );
    return res.status(201).json({
      success: true,
      message: 'Worker attendance recorded successfully',
      id: result.insertId,
      calculated_wage: calculatedWage,
      wage_advance: wageAdvance,
      wage_balance: wageBalance
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Attendance already exists for this worker, project, and date'
      });
    }
    console.error('Create worker attendance error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to record worker attendance'
    });
  }
});

app.get('/api/projects', async (req, res) => {
  try {
    const [projects] = await pool.query(
      'SELECT * FROM projects ORDER BY id DESC'
    );

    res.json({
      success: true,
      count: projects.length,
      data: projects
    });
  } catch (error) {
    console.error('Projects API error:', error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


app.post('/api/projects', async (req, res) => {
  try {
    const {
      project_name,
      customer_name,
      location,
      estimated_budget,
      start_date,
      end_date
    } = req.body;

    if (!project_name || !project_name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Project name is required'
      });
    }

    const budget = Number(estimated_budget || 0);

    if (!Number.isFinite(budget) || budget < 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid estimated budget'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO projects
      (project_name, customer_name, location,
       estimated_budget, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        project_name.trim(),
        customer_name || null,
        location || null,
        budget,
        start_date || null,
        end_date || null
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Project created successfully',
      project_id: result.insertId
    });
  } catch (error) {
    console.error('Create project error:', error.message);

    res.status(500).json({
      success: false,
      message: 'Failed to create project'
    });
  }
});

/* Get one project by ID */
app.get('/api/projects/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    const [rows] = await pool.query(
      'SELECT * FROM projects WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch project'
    });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      message: 'Invalid project ID'
    });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      message: 'A project object is required'
    });
  }

  const {
    project_name,
    customer_name,
    location,
    estimated_budget
  } = body;

  if (typeof project_name !== 'string' || !project_name.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Project name is required'
    });
  }

  for (const [field, value] of [
    ['customer_name', customer_name],
    ['location', location]
  ]) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return res.status(400).json({
        success: false,
        message: `${field} must be a string or null`
      });
    }
  }

  if (
    estimated_budget === undefined ||
    estimated_budget === null ||
    (typeof estimated_budget !== 'number' &&
      !(typeof estimated_budget === 'string' &&
        estimated_budget.trim() !== ''))
  ) {
    return res.status(400).json({
      success: false,
      message: 'Estimated budget must be a non-negative number'
    });
  }

  const budget = Number(estimated_budget);
  if (!Number.isFinite(budget) || budget < 0) {
    return res.status(400).json({
      success: false,
      message: 'Estimated budget must be a non-negative number'
    });
  }

  try {
    const [existingProjects] = await pool.query(
      'SELECT id FROM projects WHERE id = ?',
      [id]
    );

    if (existingProjects.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    await pool.query(
      `UPDATE projects
       SET project_name = ?, customer_name = ?, location = ?,
           estimated_budget = ?
       WHERE id = ?`,
      [
        project_name.trim(),
        customer_name?.trim() || null,
        location?.trim() || null,
        budget,
        id
      ]
    );

    return res.json({
      success: true,
      message: 'Project updated successfully'
    });
  } catch (error) {
    console.error('Update project error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update project'
    });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      message: 'Invalid project ID'
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify the project exists before removing dependent attendance rows.
    const [projectRows] = await connection.query(
      'SELECT id FROM projects WHERE id = ? FOR UPDATE',
      [id]
    );

    if (projectRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Attendance has a RESTRICT foreign key to projects, so remove its
    // project-specific rows first. Account transactions are preserved and
    // their project_id is set to NULL by the existing foreign key rule.
    const [attendanceResult] = await connection.query(
      'DELETE FROM worker_attendance WHERE project_id = ?',
      [id]
    );

    const [deleteResult] = await connection.query(
      'DELETE FROM projects WHERE id = ?',
      [id]
    );

    if (deleteResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    await connection.commit();
    return res.status(200).json({
      success: true,
      message: 'Project deleted successfully',
      deletedAttendanceRecords: attendanceResult.affectedRows
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Project delete rollback error:', rollbackError.message);
      }
    }
    console.error('Delete project error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete project. Check whether other records are linked to it.'
    });
  } finally {
    if (connection) connection.release();
  }
});

/* Update project status */
app.patch('/api/projects/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const allowedStatuses = [
      'Planning',
      'In Progress',
      'Completed',
      'On Hold',
      'Cancelled'
    ];
    const { status } = req.body;

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project status'
      });
    }

    const [result] = await pool.query(
      'UPDATE projects SET status = ? WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.json({
      success: true,
      message: 'Project status updated successfully'
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update project'
    });
  }
});

// Authentication middleware and routes

// Verify JWT token middleware
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Missing token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, name, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// POST /api/login
app.post('/api/login', async (req, res) => {
  const identifier = (req.body.email || req.body.username || '').toString().trim();
  const password = req.body.password;
  if (!identifier || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }
  try {
    const [[user]] = await require('./db').query(
      'SELECT * FROM users WHERE email = ? OR name = ?',
      [identifier, identifier]
    );
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account disabled' });
    }
    const match = await require('bcrypt').compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/me (protected)
app.get('/api/me', verifyToken, (req, res) => {
  const { id, name, email, role } = req.user;
  res.json({ success: true, user: { id, name, email, role } });
});

initializeAccountTransactionsTable()
  .then(initializePartyLedgerTables)
  .then(initializeWorkerAttendanceTable)
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`BuildMaster LK backend running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize account transactions table:', error.message);
    process.exitCode = 1;
  });
