const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'members.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const initTables = () => {
  const createMembersTable = `
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      points INTEGER NOT NULL DEFAULT 0,
      frozen_points INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('active', 'frozen')),
      CHECK (level IN ('normal', 'silver', 'gold', 'platinum')),
      CHECK (points >= 0),
      CHECK (frozen_points >= 0)
    )
  `;

  const createPointsTransactionsTable = `
    CREATE TABLE IF NOT EXISTS points_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      transaction_no TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      frozen_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      operator TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      CHECK (type IN ('earn', 'spend', 'freeze', 'unfreeze', 'expire'))
    )
  `;

  const createFrozenRecordsTable = `
    CREATE TABLE IF NOT EXISTS frozen_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      transaction_no TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'frozen',
      expire_at INTEGER,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      CHECK (status IN ('frozen', 'unfrozen', 'deducted'))
    )
  `;

  const createBenefitsTable = `
    CREATE TABLE IF NOT EXISTS benefits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benefit_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      points_cost INTEGER NOT NULL,
      total_stock INTEGER NOT NULL,
      available_stock INTEGER NOT NULL,
      expire_at INTEGER,
      min_level TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('active', 'inactive', 'sold_out')),
      CHECK (min_level IN ('normal', 'silver', 'gold', 'platinum')),
      CHECK (points_cost > 0),
      CHECK (total_stock >= 0),
      CHECK (available_stock >= 0)
    )
  `;

  const createRedemptionsTable = `
    CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      redemption_no TEXT UNIQUE NOT NULL,
      member_id INTEGER NOT NULL,
      benefit_id INTEGER NOT NULL,
      points_cost INTEGER NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      FOREIGN KEY (benefit_id) REFERENCES benefits(id),
      CHECK (status IN ('pending', 'success', 'failed'))
    )
  `;

  const createOperationLogsTable = `
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_type TEXT NOT NULL,
      operator TEXT NOT NULL,
      member_id INTEGER,
      benefit_id INTEGER,
      details TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      FOREIGN KEY (benefit_id) REFERENCES benefits(id)
    )
  `;

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_transactions_member ON points_transactions(member_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_created ON points_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_frozen_member ON frozen_records(member_id);
    CREATE INDEX IF NOT EXISTS idx_frozen_status ON frozen_records(status);
    CREATE INDEX IF NOT EXISTS idx_redemptions_member ON redemptions(member_id);
    CREATE INDEX IF NOT EXISTS idx_redemptions_benefit ON redemptions(benefit_id);
    CREATE INDEX IF NOT EXISTS idx_logs_member ON operation_logs(member_id);
    CREATE INDEX IF NOT EXISTS idx_logs_type ON operation_logs(operation_type);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON operation_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_benefits_code ON benefits(benefit_code);
    CREATE INDEX IF NOT EXISTS idx_members_no ON members(member_no);
  `;

  db.exec(createMembersTable);
  db.exec(createPointsTransactionsTable);
  db.exec(createFrozenRecordsTable);
  db.exec(createBenefitsTable);
  db.exec(createRedemptionsTable);
  db.exec(createOperationLogsTable);
  db.exec(createIndexes);
};

const logOperation = (operationType, operator, memberId = null, benefitId = null, details = null) => {
  const stmt = db.prepare(`
    INSERT INTO operation_logs (operation_type, operator, member_id, benefit_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(operationType, operator, memberId, benefitId, details, Date.now());
};

const generateTransactionNo = (prefix) => {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
};

module.exports = {
  db,
  initTables,
  logOperation,
  generateTransactionNo
};
