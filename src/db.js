const Database = require('better-sqlite3');
const path = require('path');

const dbName = process.env.DB_NAME || 'members.db';
const dbPath = path.join(__dirname, '..', 'data', dbName);
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
      CHECK (type IN ('earn', 'spend', 'freeze', 'unfreeze', 'expire', 'refund'))
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

  const createPointsBatchesTable = `
    CREATE TABLE IF NOT EXISTS points_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      batch_no TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      total_amount INTEGER NOT NULL,
      remaining_amount INTEGER NOT NULL,
      expire_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      reason TEXT NOT NULL,
      transaction_no TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      CHECK (status IN ('active', 'partially_used', 'used_up', 'expired')),
      CHECK (total_amount > 0),
      CHECK (remaining_amount >= 0)
    )
  `;

  const createPointsBatchDeductionsTable = `
    CREATE TABLE IF NOT EXISTS points_batch_deductions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      deduction_no TEXT UNIQUE NOT NULL,
      amount INTEGER NOT NULL,
      deduction_type TEXT NOT NULL,
      related_no TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES points_batches(id),
      FOREIGN KEY (member_id) REFERENCES members(id),
      CHECK (deduction_type IN ('spend', 'expire', 'freeze', 'refund'))
    )
  `;

  const createRiskControlRulesTable = `
    CREATE TABLE IF NOT EXISTS risk_control_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_code TEXT UNIQUE NOT NULL,
      rule_name TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      min_level TEXT DEFAULT 'normal',
      max_daily_redemptions INTEGER,
      max_daily_points INTEGER,
      same_benefit_interval_hours INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (rule_type IN ('level', 'daily_count', 'daily_points', 'same_benefit_interval', 'account_status')),
      CHECK (status IN ('active', 'inactive'))
    )
  `;

  const createRiskControlRecordsTable = `
    CREATE TABLE IF NOT EXISTS risk_control_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_no TEXT UNIQUE NOT NULL,
      member_id INTEGER NOT NULL,
      benefit_id INTEGER,
      rule_id INTEGER,
      rule_code TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      hit_reason TEXT NOT NULL,
      hit_value TEXT,
      threshold_value TEXT,
      status TEXT NOT NULL DEFAULT 'blocked',
      operator TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id),
      FOREIGN KEY (benefit_id) REFERENCES benefits(id),
      FOREIGN KEY (rule_id) REFERENCES risk_control_rules(id),
      CHECK (status IN ('blocked', 'reviewed', 'released'))
    )
  `;

  const createCouponsTable = `
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_code TEXT UNIQUE NOT NULL,
      redemption_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      benefit_id INTEGER NOT NULL,
      points_cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expire_at INTEGER,
      used_at INTEGER,
      voided_at INTEGER,
      expired_at INTEGER,
      void_reason TEXT,
      operator TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (redemption_id) REFERENCES redemptions(id),
      FOREIGN KEY (member_id) REFERENCES members(id),
      FOREIGN KEY (benefit_id) REFERENCES benefits(id),
      CHECK (status IN ('pending', 'used', 'voided', 'expired'))
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
    CREATE INDEX IF NOT EXISTS idx_batches_member ON points_batches(member_id);
    CREATE INDEX IF NOT EXISTS idx_batches_status ON points_batches(status);
    CREATE INDEX IF NOT EXISTS idx_batches_expire ON points_batches(expire_at);
    CREATE INDEX IF NOT EXISTS idx_batch_deductions_batch ON points_batch_deductions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_batch_deductions_member ON points_batch_deductions(member_id);
    CREATE INDEX IF NOT EXISTS idx_risk_rules_status ON risk_control_rules(status);
    CREATE INDEX IF NOT EXISTS idx_risk_records_member ON risk_control_records(member_id);
    CREATE INDEX IF NOT EXISTS idx_risk_records_created ON risk_control_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_coupons_member ON coupons(member_id);
    CREATE INDEX IF NOT EXISTS idx_coupons_benefit ON coupons(benefit_id);
    CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);
    CREATE INDEX IF NOT EXISTS idx_coupons_redemption ON coupons(redemption_id);
    CREATE INDEX IF NOT EXISTS idx_coupons_expire ON coupons(expire_at);
  `;

  db.exec(createMembersTable);
  db.exec(createPointsTransactionsTable);
  db.exec(createFrozenRecordsTable);
  db.exec(createBenefitsTable);
  db.exec(createRedemptionsTable);
  db.exec(createOperationLogsTable);
  db.exec(createPointsBatchesTable);
  db.exec(createPointsBatchDeductionsTable);
  db.exec(createRiskControlRulesTable);
  db.exec(createRiskControlRecordsTable);
  db.exec(createCouponsTable);
  db.exec(createIndexes);
};

const logOperation = (operationType, operator, memberId = null, benefitId = null, details = null) => {
  const stmt = db.prepare(`
    INSERT INTO operation_logs (operation_type, operator, member_id, benefit_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(operationType, operator, memberId, benefitId, details, Date.now());
};

let transactionCounter = 0;
const generateTransactionNo = (prefix) => {
  transactionCounter++;
  return `${prefix}${Date.now()}${transactionCounter.toString().padStart(6, '0')}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
};

module.exports = {
  db,
  initTables,
  logOperation,
  generateTransactionNo
};
