const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const assert = require('assert');

const testDbPath = path.join(__dirname, '..', 'data', 'test_members.db');

const deleteTestDb = () => {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  if (fs.existsSync(testDbPath + '-wal')) {
    fs.unlinkSync(testDbPath + '-wal');
  }
  if (fs.existsSync(testDbPath + '-shm')) {
    fs.unlinkSync(testDbPath + '-shm');
  }
};

deleteTestDb();

let db = new Database(testDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const initTables = (dbInstance) => {
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

  dbInstance.exec(createMembersTable);
  dbInstance.exec(createPointsTransactionsTable);
  dbInstance.exec(createFrozenRecordsTable);
  dbInstance.exec(createBenefitsTable);
  dbInstance.exec(createRedemptionsTable);
  dbInstance.exec(createOperationLogsTable);
};

initTables(db);

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

const VALID_LEVELS = ['normal', 'silver', 'gold', 'platinum'];
const VALID_STATUSES = ['active', 'frozen'];

const getMemberById = (id) => {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id);
};

const registerMember = (memberNo, name, level = 'normal', operator = 'system') => {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`无效的会员等级，有效值为: ${VALID_LEVELS.join(', ')}`);
  }

  const existing = db.prepare('SELECT id FROM members WHERE member_no = ?').get(memberNo);
  if (existing) {
    throw new Error('会员号已存在');
  }

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO members (member_no, name, level, status, points, frozen_points, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 0, 0, ?, ?)
  `);
  const result = stmt.run(memberNo, name, level, now, now);

  logOperation('member_register', operator, result.lastInsertRowid, null, `注册会员: ${name}, 等级: ${level}`);

  return getMemberById(result.lastInsertRowid);
};

const getMemberByNo = (memberNo) => {
  return db.prepare('SELECT * FROM members WHERE member_no = ?').get(memberNo);
};

const freezeMember = (memberId, operator = 'system', reason = '') => {
  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }
  if (member.status === 'frozen') {
    throw new Error('会员已处于冻结状态');
  }

  const stmt = db.prepare('UPDATE members SET status = ?, updated_at = ? WHERE id = ?');
  stmt.run('frozen', Date.now(), memberId);

  logOperation('member_freeze', operator, memberId, null, reason || '冻结会员账号');

  return getMemberById(memberId);
};

const unfreezeMember = (memberId, operator = 'system', reason = '') => {
  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }
  if (member.status === 'active') {
    throw new Error('会员未处于冻结状态');
  }

  const stmt = db.prepare('UPDATE members SET status = ?, updated_at = ? WHERE id = ?');
  stmt.run('active', Date.now(), memberId);

  logOperation('member_unfreeze', operator, memberId, null, reason || '解冻会员账号');

  return getMemberById(memberId);
};

const getMemberPointsInfo = (memberId) => {
  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const availablePoints = member.points - member.frozen_points;

  const frozenRecords = db.prepare(`
    SELECT * FROM frozen_records 
    WHERE member_id = ? AND status = 'frozen'
    ORDER BY created_at DESC
  `).all(memberId);

  return {
    member_id: member.id,
    member_no: member.member_no,
    name: member.name,
    level: member.level,
    status: member.status,
    total_points: member.points,
    frozen_points: member.frozen_points,
    available_points: availablePoints >= 0 ? availablePoints : 0,
    frozen_records: frozenRecords
  };
};

const earnPoints = (memberId, amount, reason, operator = 'system') => {
  if (amount <= 0) {
    throw new Error('积分数量必须大于0');
  }
  if (!reason || reason.trim() === '') {
    throw new Error('必须提供积分获取原因');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const transaction = db.transaction(() => {
    const newPoints = member.points + amount;
    const transactionNo = generateTransactionNo('TXN');
    const now = Date.now();

    const updateMemberStmt = db.prepare(`
      UPDATE members SET points = ?, updated_at = ? WHERE id = ?
    `);
    updateMemberStmt.run(newPoints, now, memberId);

    const insertTransactionStmt = db.prepare(`
      INSERT INTO points_transactions 
      (member_id, transaction_no, type, amount, balance_after, frozen_after, reason, operator, created_at)
      VALUES (?, ?, 'earn', ?, ?, ?, ?, ?, ?)
    `);
    insertTransactionStmt.run(
      memberId,
      transactionNo,
      amount,
      newPoints,
      member.frozen_points,
      reason,
      operator,
      now
    );

    logOperation('points_earn', operator, memberId, null, 
      `获取积分 ${amount}，原因: ${reason}，交易号: ${transactionNo}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      balance_after: newPoints,
      type: 'earn',
      reason,
      created_at: now
    };
  });

  return transaction();
};

const spendPoints = (memberId, amount, reason, operator = 'system') => {
  if (amount <= 0) {
    throw new Error('积分数量必须大于0');
  }
  if (!reason || reason.trim() === '') {
    throw new Error('必须提供积分扣减原因');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const availablePoints = member.points - member.frozen_points;
  if (availablePoints < amount) {
    throw new Error('积分不足');
  }

  const transaction = db.transaction(() => {
    const newPoints = member.points - amount;
    const transactionNo = generateTransactionNo('TXN');
    const now = Date.now();

    const updateMemberStmt = db.prepare(`
      UPDATE members SET points = ?, updated_at = ? WHERE id = ?
    `);
    updateMemberStmt.run(newPoints, now, memberId);

    const insertTransactionStmt = db.prepare(`
      INSERT INTO points_transactions 
      (member_id, transaction_no, type, amount, balance_after, frozen_after, reason, operator, created_at)
      VALUES (?, ?, 'spend', ?, ?, ?, ?, ?, ?)
    `);
    insertTransactionStmt.run(
      memberId,
      transactionNo,
      -amount,
      newPoints,
      member.frozen_points,
      reason,
      operator,
      now
    );

    logOperation('points_spend', operator, memberId, null, 
      `扣减积分 ${amount}，原因: ${reason}，交易号: ${transactionNo}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      balance_after: newPoints,
      type: 'spend',
      reason,
      created_at: now
    };
  });

  return transaction();
};

const freezePoints = (memberId, amount, reason, operator = 'system', expireAt = null) => {
  if (amount <= 0) {
    throw new Error('冻结积分数量必须大于0');
  }
  if (!reason || reason.trim() === '') {
    throw new Error('必须提供冻结原因');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const availablePoints = member.points - member.frozen_points;
  if (availablePoints < amount) {
    throw new Error('可用积分不足，无法冻结');
  }

  const transaction = db.transaction(() => {
    const newFrozenPoints = member.frozen_points + amount;
    const transactionNo = generateTransactionNo('FRZ');
    const now = Date.now();

    const updateMemberStmt = db.prepare(`
      UPDATE members SET frozen_points = ?, updated_at = ? WHERE id = ?
    `);
    updateMemberStmt.run(newFrozenPoints, now, memberId);

    const insertTransactionStmt = db.prepare(`
      INSERT INTO points_transactions 
      (member_id, transaction_no, type, amount, balance_after, frozen_after, reason, operator, created_at)
      VALUES (?, ?, 'freeze', ?, ?, ?, ?, ?, ?)
    `);
    insertTransactionStmt.run(
      memberId,
      transactionNo,
      0,
      member.points,
      newFrozenPoints,
      reason,
      operator,
      now
    );

    const insertFrozenRecordStmt = db.prepare(`
      INSERT INTO frozen_records 
      (member_id, transaction_no, amount, status, expire_at, reason, created_at, updated_at)
      VALUES (?, ?, ?, 'frozen', ?, ?, ?, ?)
    `);
    insertFrozenRecordStmt.run(memberId, transactionNo, amount, expireAt, reason, now, now);

    logOperation('points_freeze', operator, memberId, null, 
      `冻结积分 ${amount}，原因: ${reason}，冻结号: ${transactionNo}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      frozen_after: newFrozenPoints,
      type: 'freeze',
      reason,
      expire_at: expireAt,
      created_at: now
    };
  });

  return transaction();
};

const unfreezePoints = (memberId, frozenRecordId, operator = 'system', reason = '') => {
  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const frozenRecord = db.prepare(`
    SELECT * FROM frozen_records WHERE id = ? AND member_id = ? AND status = 'frozen'
  `).get(frozenRecordId, memberId);

  if (!frozenRecord) {
    throw new Error('冻结记录不存在或已解冻');
  }

  const transaction = db.transaction(() => {
    const newFrozenPoints = member.frozen_points - frozenRecord.amount;
    const transactionNo = generateTransactionNo('UFR');
    const now = Date.now();

    if (newFrozenPoints < 0) {
      throw new Error('解冻后冻结积分不能为负数');
    }

    const updateMemberStmt = db.prepare(`
      UPDATE members SET frozen_points = ?, updated_at = ? WHERE id = ?
    `);
    updateMemberStmt.run(newFrozenPoints, now, memberId);

    const insertTransactionStmt = db.prepare(`
      INSERT INTO points_transactions 
      (member_id, transaction_no, type, amount, balance_after, frozen_after, reason, operator, created_at)
      VALUES (?, ?, 'unfreeze', ?, ?, ?, ?, ?, ?)
    `);
    insertTransactionStmt.run(
      memberId,
      transactionNo,
      0,
      member.points,
      newFrozenPoints,
      reason || '解冻冻结积分',
      operator,
      now
    );

    const updateFrozenRecordStmt = db.prepare(`
      UPDATE frozen_records SET status = 'unfrozen', updated_at = ? WHERE id = ?
    `);
    updateFrozenRecordStmt.run(now, frozenRecordId);

    logOperation('points_unfreeze', operator, memberId, null, 
      `解冻积分 ${frozenRecord.amount}，原冻结号: ${frozenRecord.transaction_no}，解冻号: ${transactionNo}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount: frozenRecord.amount,
      frozen_after: newFrozenPoints,
      type: 'unfreeze',
      reason: reason || '解冻冻结积分',
      created_at: now
    };
  });

  return transaction();
};

const getTransactionHistory = (memberId, { type, startTime, endTime, offset = 0, limit = 100 } = {}) => {
  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  let sql = 'SELECT * FROM points_transactions WHERE member_id = ?';
  const params = [memberId];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (startTime) {
    sql += ' AND created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND created_at <= ?';
    params.push(endTime);
  }

  sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const getFrozenRecords = (memberId, { status, offset = 0, limit = 100 } = {}) => {
  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  let sql = 'SELECT * FROM frozen_records WHERE member_id = ?';
  const params = [memberId];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const getBenefitById = (id) => {
  return db.prepare('SELECT * FROM benefits WHERE id = ?').get(id);
};

const createBenefit = (benefitCode, name, pointsCost, totalStock, {
  description = '',
  expireAt = null,
  minLevel = 'normal',
  operator = 'system'
} = {}) => {
  if (!benefitCode || benefitCode.trim() === '') {
    throw new Error('权益编码不能为空');
  }
  if (!name || name.trim() === '') {
    throw new Error('权益名称不能为空');
  }
  if (pointsCost <= 0) {
    throw new Error('所需积分必须大于0');
  }
  if (totalStock < 0) {
    throw new Error('总库存不能为负数');
  }
  if (!VALID_LEVELS.includes(minLevel)) {
    throw new Error(`无效的最低会员等级，有效值为: ${VALID_LEVELS.join(', ')}`);
  }

  const existing = db.prepare('SELECT id FROM benefits WHERE benefit_code = ?').get(benefitCode);
  if (existing) {
    throw new Error('权益编码已存在');
  }

  const now = Date.now();
  const status = totalStock > 0 ? 'active' : 'sold_out';

  const stmt = db.prepare(`
    INSERT INTO benefits 
    (benefit_code, name, description, points_cost, total_stock, available_stock, 
     expire_at, min_level, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    benefitCode, name, description, pointsCost, totalStock, totalStock,
    expireAt, minLevel, status, now, now
  );

  logOperation('benefit_create', operator, null, result.lastInsertRowid, 
    `创建权益: ${name}，编码: ${benefitCode}，积分: ${pointsCost}，库存: ${totalStock}`);

  return getBenefitById(result.lastInsertRowid);
};

const getExpiringBenefits = (days = 7) => {
  const now = Date.now();
  const expireThreshold = now + days * 24 * 60 * 60 * 1000;

  return db.prepare(`
    SELECT * FROM benefits
    WHERE status = 'active'
      AND expire_at IS NOT NULL
      AND expire_at <= ?
      AND expire_at > ?
    ORDER BY expire_at ASC
  `).all(expireThreshold, now);
};

const checkLevelPermission = (memberLevel, benefitMinLevel) => {
  const levelOrder = { normal: 0, silver: 1, gold: 2, platinum: 3 };
  return levelOrder[memberLevel] >= levelOrder[benefitMinLevel];
};

const canRedeemBenefit = (benefitId) => {
  const benefit = getBenefitById(benefitId);
  if (!benefit) {
    return { canRedeem: false, reason: '权益不存在' };
  }
  if (benefit.status !== 'active') {
    return { canRedeem: false, reason: benefit.status === 'sold_out' ? '权益已售罄' : '权益已下架' };
  }
  if (benefit.available_stock <= 0) {
    return { canRedeem: false, reason: '权益库存不足' };
  }
  if (benefit.expire_at && benefit.expire_at < Date.now()) {
    return { canRedeem: false, reason: '权益已过期' };
  }
  return { canRedeem: true, reason: null, benefit };
};

const redeemBenefit = (memberId, benefitId, operator = 'system') => {
  const redemptionNo = generateTransactionNo('RED');
  const now = Date.now();

  const createPendingRedemption = () => {
    const stmt = db.prepare(`
      INSERT INTO redemptions 
      (redemption_no, member_id, benefit_id, points_cost, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'pending', ?, ?)
    `);
    return stmt.run(redemptionNo, memberId, benefitId, now, now).lastInsertRowid;
  };

  const updateRedemptionStatus = (id, status, pointsCost, failureReason = null) => {
    const stmt = db.prepare(`
      UPDATE redemptions 
      SET status = ?, points_cost = ?, failure_reason = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, pointsCost, failureReason, Date.now(), id);
  };

  const redemptionId = createPendingRedemption();

  try {
    const member = getMemberById(memberId);
    if (!member) {
      throw new Error('会员不存在');
    }

    if (member.status === 'frozen') {
      updateRedemptionStatus(redemptionId, 'failed', 0, '账号已冻结');
      logOperation('redemption_failed', operator, memberId, benefitId, 
        `兑换失败: 账号已冻结，兑换单号: ${redemptionNo}`);
      return {
        success: false,
        redemption_no: redemptionNo,
        reason: '账号已冻结',
        details: '会员账号处于冻结状态，无法进行权益兑换'
      };
    }

    const redeemCheck = canRedeemBenefit(benefitId);
    if (!redeemCheck.canRedeem) {
      updateRedemptionStatus(redemptionId, 'failed', 0, redeemCheck.reason);
      logOperation('redemption_failed', operator, memberId, benefitId, 
        `兑换失败: ${redeemCheck.reason}，兑换单号: ${redemptionNo}`);
      return {
        success: false,
        redemption_no: redemptionNo,
        reason: redeemCheck.reason,
        details: `权益状态异常: ${redeemCheck.reason}`
      };
    }

    const benefit = redeemCheck.benefit;

    if (!checkLevelPermission(member.level, benefit.min_level)) {
      updateRedemptionStatus(redemptionId, 'failed', 0, '会员等级不足');
      logOperation('redemption_failed', operator, memberId, benefitId, 
        `兑换失败: 会员等级不足，需要 ${benefit.min_level}，当前 ${member.level}，兑换单号: ${redemptionNo}`);
      return {
        success: false,
        redemption_no: redemptionNo,
        reason: '会员等级不足',
        details: `该权益需要 ${benefit.min_level} 等级，您当前等级为 ${member.level}`
      };
    }

    const pointsInfo = getMemberPointsInfo(memberId);
    if (pointsInfo.available_points < benefit.points_cost) {
      updateRedemptionStatus(redemptionId, 'failed', 0, '积分不足');
      logOperation('redemption_failed', operator, memberId, benefitId, 
        `兑换失败: 积分不足，需要 ${benefit.points_cost}，可用 ${pointsInfo.available_points}，兑换单号: ${redemptionNo}`);
      return {
        success: false,
        redemption_no: redemptionNo,
        reason: '积分不足',
        details: `需要 ${benefit.points_cost} 积分，您当前可用 ${pointsInfo.available_points} 积分`
      };
    }

    const transaction = db.transaction(() => {
      const newAvailableStock = benefit.available_stock - 1;
      const newStatus = newAvailableStock > 0 ? 'active' : 'sold_out';

      const updateBenefitStmt = db.prepare(`
        UPDATE benefits 
        SET available_stock = ?, status = ?, updated_at = ?
        WHERE id = ?
      `);
      updateBenefitStmt.run(newAvailableStock, newStatus, Date.now(), benefitId);

      const spendResult = spendPoints(memberId, benefit.points_cost, 
        `兑换权益: ${benefit.name}`, operator);

      updateRedemptionStatus(redemptionId, 'success', benefit.points_cost, null);

      return { spendResult, newAvailableStock };
    });

    const result = transaction();

    logOperation('redemption_success', operator, memberId, benefitId, 
      `兑换成功: ${benefit.name}，消耗积分 ${benefit.points_cost}，兑换单号: ${redemptionNo}`);

    return {
      success: true,
      redemption_no: redemptionNo,
      member_id: memberId,
      member_name: member.name,
      benefit_id: benefitId,
      benefit_name: benefit.name,
      points_cost: benefit.points_cost,
      balance_after: result.spendResult.balance_after,
      remaining_stock: result.newAvailableStock,
      created_at: now
    };

  } catch (error) {
    updateRedemptionStatus(redemptionId, 'failed', 0, error.message);
    logOperation('redemption_failed', operator, memberId, benefitId, 
      `兑换失败: ${error.message}，兑换单号: ${redemptionNo}`);
    return {
      success: false,
      redemption_no: redemptionNo,
      reason: '系统错误',
      details: error.message
    };
  }
};

const getRedemptionByNo = (redemptionNo) => {
  return db.prepare(`
    SELECT r.*, m.member_no, m.name as member_name, b.name as benefit_name, b.benefit_code
    FROM redemptions r
    JOIN members m ON r.member_id = m.id
    JOIN benefits b ON r.benefit_id = b.id
    WHERE r.redemption_no = ?
  `).get(redemptionNo);
};

const listRedemptions = ({ memberId, benefitId, status, startTime, endTime, offset = 0, limit = 100 } = {}) => {
  let sql = `
    SELECT r.*, m.member_no, m.name as member_name, m.level as member_level, 
           b.name as benefit_name, b.benefit_code
    FROM redemptions r
    JOIN members m ON r.member_id = m.id
    JOIN benefits b ON r.benefit_id = b.id
    WHERE 1=1
  `;
  const params = [];

  if (memberId) {
    sql += ' AND r.member_id = ?';
    params.push(memberId);
  }
  if (benefitId) {
    sql += ' AND r.benefit_id = ?';
    params.push(benefitId);
  }
  if (status) {
    sql += ' AND r.status = ?';
    params.push(status);
  }
  if (startTime) {
    sql += ' AND r.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND r.created_at <= ?';
    params.push(endTime);
  }

  sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const listOperationLogs = ({
  operationType,
  operator,
  memberId,
  memberLevel,
  benefitId,
  startTime,
  endTime,
  offset = 0,
  limit = 100
} = {}) => {
  let sql = `
    SELECT ol.*, 
           m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name
    FROM operation_logs ol
    LEFT JOIN members m ON ol.member_id = m.id
    LEFT JOIN benefits b ON ol.benefit_id = b.id
    WHERE 1=1
  `;
  const params = [];

  if (operationType) {
    sql += ' AND ol.operation_type = ?';
    params.push(operationType);
  }
  if (operator) {
    sql += ' AND ol.operator = ?';
    params.push(operator);
  }
  if (memberId) {
    sql += ' AND ol.member_id = ?';
    params.push(memberId);
  }
  if (memberLevel) {
    if (!VALID_LEVELS.includes(memberLevel)) {
      throw new Error(`无效的会员等级，有效值为: ${VALID_LEVELS.join(', ')}`);
    }
    sql += ' AND m.level = ?';
    params.push(memberLevel);
  }
  if (benefitId) {
    sql += ' AND ol.benefit_id = ?';
    params.push(benefitId);
  }
  if (startTime) {
    sql += ' AND ol.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND ol.created_at <= ?';
    params.push(endTime);
  }

  sql += ' ORDER BY ol.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

let testResults = [];
let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    testResults.push({ name, status: 'pass' });
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    testResults.push({ name, status: 'fail', error: error.message });
    failed++;
  }
};

console.log('\n========================================');
console.log('  会员积分与权益中心 - 验收测试');
console.log('========================================\n');

console.log('1. 会员管理测试');
test('注册普通会员成功', () => {
  const member = registerMember('M001', '张三', 'normal', 'admin');
  assert.strictEqual(member.member_no, 'M001');
  assert.strictEqual(member.name, '张三');
  assert.strictEqual(member.level, 'normal');
  assert.strictEqual(member.status, 'active');
  assert.strictEqual(member.points, 0);
  assert.strictEqual(member.frozen_points, 0);
  global.member1Id = member.id;
});

test('注册黄金会员成功', () => {
  const member = registerMember('M002', '李四', 'gold', 'admin');
  assert.strictEqual(member.level, 'gold');
  global.member2Id = member.id;
});

test('获取会员积分信息', () => {
  const info = getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.available_points, 0);
  assert.strictEqual(info.total_points, 0);
});

console.log('\n2. 积分管理测试');
test('获取积分 1000 成功', () => {
  const result = earnPoints(global.member1Id, 1000, '消费返点', 'admin');
  assert.strictEqual(result.amount, 1000);
  assert.strictEqual(result.balance_after, 1000);
  assert.strictEqual(result.type, 'earn');
});

test('获取积分后余额正确', () => {
  const info = getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.total_points, 1000);
  assert.strictEqual(info.available_points, 1000);
});

test('冻结 300 积分成功', () => {
  const result = freezePoints(global.member1Id, 300, '预兑换冻结', 'admin');
  assert.strictEqual(result.amount, 300);
  assert.strictEqual(result.frozen_after, 300);
});

test('冻结后可用积分正确', () => {
  const info = getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.total_points, 1000);
  assert.strictEqual(info.frozen_points, 300);
  assert.strictEqual(info.available_points, 700);
});

test('积分流水可追踪', () => {
  const transactions = getTransactionHistory(global.member1Id);
  assert.strictEqual(transactions.length, 2);
  const types = transactions.map(t => t.type);
  assert.ok(types.includes('earn'));
  assert.ok(types.includes('freeze'));
  assert.ok(transactions[0].transaction_no);
  assert.ok(transactions[1].transaction_no);
});

test('解冻积分成功', () => {
  const frozenRecords = getFrozenRecords(global.member1Id, { status: 'frozen' });
  assert.strictEqual(frozenRecords.length, 1);
  const result = unfreezePoints(global.member1Id, frozenRecords[0].id, 'admin', '取消冻结');
  assert.strictEqual(result.frozen_after, 0);
});

test('解冻后可用积分恢复', () => {
  const info = getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.available_points, 1000);
  assert.strictEqual(info.frozen_points, 0);
});

console.log('\n3. 权益管理测试');
test('创建权益 - 100元优惠券（库存5）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = createBenefit('COUPON100', '100元优惠券', 500, 5, {
    description: '全场通用100元优惠券',
    expireAt: future,
    minLevel: 'normal',
    operator: 'admin'
  });
  assert.strictEqual(benefit.benefit_code, 'COUPON100');
  assert.strictEqual(benefit.points_cost, 500);
  assert.strictEqual(benefit.total_stock, 5);
  assert.strictEqual(benefit.available_stock, 5);
  assert.strictEqual(benefit.status, 'active');
  global.benefit1Id = benefit.id;
});

test('创建权益 - 黄金会员专属礼品（库存2）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = createBenefit('GOLD_GIFT', '黄金会员专属礼品', 2000, 2, {
    description: '黄金会员专享精美礼品',
    expireAt: future,
    minLevel: 'gold',
    operator: 'admin'
  });
  assert.strictEqual(benefit.min_level, 'gold');
  global.benefit2Id = benefit.id;
});

test('创建权益 - 高积分普通权益（库存3）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = createBenefit('EXPENSIVE', '高积分礼品', 3000, 3, {
    expireAt: future,
    minLevel: 'normal',
    operator: 'admin'
  });
  global.benefit4Id = benefit.id;
});

test('创建权益 - 限量商品（库存1）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = createBenefit('LIMITED', '限量版商品', 800, 1, {
    expireAt: future,
    minLevel: 'normal',
    operator: 'admin'
  });
  global.benefit3Id = benefit.id;
});

console.log('\n4. 权益兑换测试');
console.log('   4.1 正常兑换测试');
test('正常兑换后余额变化正确', () => {
  const beforeInfo = getMemberPointsInfo(global.member1Id);
  const beforeBenefit = getBenefitById(global.benefit1Id);
  
  assert.strictEqual(beforeInfo.available_points, 1000);
  assert.strictEqual(beforeBenefit.available_stock, 5);

  const result = redeemBenefit(global.member1Id, global.benefit1Id, 'admin');
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.points_cost, 500);
  
  const afterInfo = getMemberPointsInfo(global.member1Id);
  const afterBenefit = getBenefitById(global.benefit1Id);
  
  assert.strictEqual(afterInfo.total_points, 500);
  assert.strictEqual(afterInfo.available_points, 500);
  assert.strictEqual(afterBenefit.available_stock, 4);
  assert.strictEqual(result.balance_after, 500);
  assert.strictEqual(result.remaining_stock, 4);
  
  global.redemption1No = result.redemption_no;
});

test('兑换记录可查询', () => {
  const redemption = getRedemptionByNo(global.redemption1No);
  assert.strictEqual(redemption.status, 'success');
  assert.strictEqual(redemption.points_cost, 500);
});

console.log('\n   4.2 冻结账号不能兑换测试');
test('冻结会员账号', () => {
  const result = freezeMember(global.member1Id, 'admin', '异常操作冻结');
  assert.strictEqual(result.status, 'frozen');
});

test('冻结账号兑换失败 - 提示账号已冻结', () => {
  const result = redeemBenefit(global.member1Id, global.benefit1Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, '账号已冻结');
  assert.ok(result.details.includes('冻结状态'));
  
  const info = getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.available_points, 500);
});

test('解冻会员账号', () => {
  const result = unfreezeMember(global.member1Id, 'admin', '核实无误解冻');
  assert.strictEqual(result.status, 'active');
});

console.log('\n   4.3 积分不足兑换失败测试');
test('积分不足兑换失败 - 提示积分不足', () => {
  const info = getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.available_points, 500);
  
  const result = redeemBenefit(global.member1Id, global.benefit4Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, '积分不足');
  assert.ok(result.details.includes('需要 3000 积分'));
  assert.ok(result.details.includes('可用 500 积分'));
});

console.log('\n   4.4 库存不足兑换失败测试');
test('第一个用户兑换限量商品成功', () => {
  earnPoints(global.member2Id, 1000, '新会员奖励', 'admin');
  const result = redeemBenefit(global.member2Id, global.benefit3Id, 'admin');
  assert.strictEqual(result.success, true);
  
  const benefit = getBenefitById(global.benefit3Id);
  assert.strictEqual(benefit.available_stock, 0);
  assert.strictEqual(benefit.status, 'sold_out');
});

test('库存不足兑换失败 - 提示权益已售罄', () => {
  earnPoints(global.member1Id, 1000, '消费返点', 'admin');
  const result = redeemBenefit(global.member1Id, global.benefit3Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, '权益已售罄');
});

console.log('\n   4.5 等级不足兑换失败测试');
test('等级不足兑换失败 - 提示会员等级不足', () => {
  const result = redeemBenefit(global.member1Id, global.benefit2Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, '会员等级不足');
  assert.ok(result.details.includes('需要 gold 等级'));
  assert.ok(result.details.includes('当前等级为 normal'));
});

console.log('\n5. 数据持久化测试');
test('关闭并重新打开数据库后数据一致', () => {
  const beforeMember1 = getMemberById(global.member1Id);
  const beforeBenefit1 = getBenefitById(global.benefit1Id);
  const beforeBenefit3 = getBenefitById(global.benefit3Id);
  const beforeRedemption = getRedemptionByNo(global.redemption1No);
  const beforeFrozenRecord = db.prepare('SELECT * FROM frozen_records WHERE member_id = ?').get(global.member1Id);

  db.close();
  
  db = new Database(testDbPath);
  db.pragma('journal_mode = WAL');
  
  const member1 = getMemberById(global.member1Id);
  assert.strictEqual(member1.points, 1500);
  assert.strictEqual(member1.status, 'active');
  assert.strictEqual(member1.points, beforeMember1.points);
  
  const benefit1 = getBenefitById(global.benefit1Id);
  assert.strictEqual(benefit1.available_stock, 4);
  assert.strictEqual(benefit1.available_stock, beforeBenefit1.available_stock);
  
  const benefit3 = getBenefitById(global.benefit3Id);
  assert.strictEqual(benefit3.status, 'sold_out');
  assert.strictEqual(benefit3.available_stock, 0);
  assert.strictEqual(benefit3.status, beforeBenefit3.status);
  
  const redemption = getRedemptionByNo(global.redemption1No);
  assert.strictEqual(redemption.status, 'success');
  assert.strictEqual(redemption.points_cost, 500);
  assert.strictEqual(redemption.status, beforeRedemption.status);
  
  const frozenRecord = db.prepare('SELECT * FROM frozen_records WHERE member_id = ?').get(global.member1Id);
  assert.strictEqual(frozenRecord.status, 'unfrozen');
  assert.strictEqual(frozenRecord.status, beforeFrozenRecord.status);
});

console.log('\n6. 操作日志与筛选测试');
test('操作日志记录完整', () => {
  const logs = listOperationLogs({ memberId: global.member1Id });
  assert.ok(logs.length >= 5);
  
  const types = logs.map(l => l.operation_type);
  assert.ok(types.includes('member_register'));
  assert.ok(types.includes('points_earn'));
  assert.ok(types.includes('points_freeze'));
  assert.ok(types.includes('points_unfreeze'));
  assert.ok(types.includes('redemption_success'));
});

test('按会员等级筛选日志', () => {
  const goldLogs = listOperationLogs({ memberLevel: 'gold' });
  assert.ok(goldLogs.length >= 2);
  
  goldLogs.forEach(log => {
    assert.strictEqual(log.member_level, 'gold');
  });
});

test('按时间筛选日志', () => {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneHourLater = now + 60 * 60 * 1000;
  
  const recentLogs = listOperationLogs({
    startTime: oneHourAgo,
    endTime: oneHourLater
  });
  assert.ok(recentLogs.length > 0);
  
  const oldLogs = listOperationLogs({
    endTime: oneHourAgo
  });
  assert.strictEqual(oldLogs.length, 0);
});

test('按操作类型筛选日志', () => {
  const earnLogs = listOperationLogs({ operationType: 'points_earn' });
  assert.ok(earnLogs.length >= 2);
  
  earnLogs.forEach(log => {
    assert.strictEqual(log.operation_type, 'points_earn');
  });
});

test('兑换记录可复查', () => {
  const redemptions = listRedemptions({ memberId: global.member1Id });
  assert.ok(redemptions.length >= 3);
  
  const successRedemption = redemptions.find(r => r.status === 'success');
  assert.ok(successRedemption);
  assert.strictEqual(successRedemption.benefit_code, 'COUPON100');
  
  const failedRedemptions = redemptions.filter(r => r.status === 'failed');
  assert.ok(failedRedemptions.length >= 2);
  
  const frozenFailure = failedRedemptions.find(r => r.failure_reason === '账号已冻结');
  assert.ok(frozenFailure);
});

console.log('\n7. 到期提醒测试');
test('获取即将到期的权益', () => {
  const expiring = getExpiringBenefits(30);
  assert.ok(expiring.length >= 2);
});

console.log('\n========================================');
console.log('  测试结果汇总');
console.log('========================================');
console.log(`  总计: ${testResults.length} 个测试`);
console.log(`  通过: ${passed} 个`);
console.log(`  失败: ${failed} 个`);
console.log('========================================');

if (failed > 0) {
  console.log('\n  失败的测试:');
  testResults.filter(r => r.status === 'fail').forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  });
  process.exit(1);
} else {
  console.log('\n  ✓ 所有测试通过！');
  process.exit(0);
}
