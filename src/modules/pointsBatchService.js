const { db, logOperation, generateTransactionNo } = require('../db');
const { getMemberById } = require('./memberService');

const generateBatchNo = () => generateTransactionNo('BCH');
const generateDeductionNo = () => generateTransactionNo('DCT');

const createBatch = (memberId, amount, source, reason, { expireAt = null, transactionNo = null } = {}) => {
  if (amount <= 0) {
    throw new Error('批次积分数量必须大于0');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const now = Date.now();
  const batchNo = generateBatchNo();

  const stmt = db.prepare(`
    INSERT INTO points_batches
    (member_id, batch_no, source, total_amount, remaining_amount, expire_at, status, reason, transaction_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `);
  const result = stmt.run(
    memberId, batchNo, source, amount, amount, expireAt, reason, transactionNo, now, now
  );

  logOperation('points_batch_create', 'system', memberId, null,
    `创建积分批次 ${batchNo}，数量: ${amount}，来源: ${source}，原因: ${reason}`);

  return getBatchById(result.lastInsertRowid);
};

const getBatchById = (id) => {
  return db.prepare('SELECT * FROM points_batches WHERE id = ?').get(id);
};

const getBatchByNo = (batchNo) => {
  return db.prepare('SELECT * FROM points_batches WHERE batch_no = ?').get(batchNo);
};

const listBatches = (memberId, { status, source, offset = 0, limit = 100 } = {}) => {
  let sql = 'SELECT * FROM points_batches WHERE member_id = ?';
  const params = [memberId];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }

  sql += ' ORDER BY expire_at IS NULL, expire_at ASC, created_at ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const getAvailableBatchesForSpend = (memberId) => {
  return db.prepare(`
    SELECT * FROM points_batches
    WHERE member_id = ?
      AND status IN ('active', 'partially_used')
      AND remaining_amount > 0
    ORDER BY expire_at IS NULL, expire_at ASC, created_at ASC
  `).all(memberId);
};

const getTotalAvailablePoints = (memberId) => {
  const result = db.prepare(`
    SELECT COALESCE(SUM(remaining_amount), 0) as total
    FROM points_batches
    WHERE member_id = ?
      AND status IN ('active', 'partially_used')
      AND remaining_amount > 0
      AND (expire_at IS NULL OR expire_at > ?)
  `).get(memberId, Date.now());

  return result.total;
};

const deductPointsByFifo = (memberId, amount, deductionType, reason, { relatedNo = null, operator = 'system' } = {}) => {
  if (amount <= 0) {
    throw new Error('扣减积分数量必须大于0');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const availablePoints = getTotalAvailablePoints(memberId);
  if (availablePoints < amount) {
    throw new Error('可用积分不足');
  }

  const transaction = db.transaction(() => {
    const batches = getAvailableBatchesForSpend(memberId);
    let remainingToDeduct = amount;
    const deductions = [];
    const now = Date.now();

    for (const batch of batches) {
      if (remainingToDeduct <= 0) break;

      const deductFromBatch = Math.min(batch.remaining_amount, remainingToDeduct);
      const deductionNo = generateDeductionNo();

      const insertDeductionStmt = db.prepare(`
        INSERT INTO points_batch_deductions
        (batch_id, member_id, deduction_no, amount, deduction_type, related_no, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertDeductionStmt.run(
        batch.id, memberId, deductionNo, deductFromBatch, deductionType, relatedNo, reason, now
      );

      const newRemaining = batch.remaining_amount - deductFromBatch;
      const newStatus = newRemaining === 0 ? 'used_up' : 'partially_used';

      const updateBatchStmt = db.prepare(`
        UPDATE points_batches
        SET remaining_amount = ?, status = ?, updated_at = ?
        WHERE id = ?
      `);
      updateBatchStmt.run(newRemaining, newStatus, now, batch.id);

      deductions.push({
        batch_id: batch.id,
        batch_no: batch.batch_no,
        amount: deductFromBatch,
        deduction_no: deductionNo
      });

      remainingToDeduct -= deductFromBatch;
    }

    return {
      total_deducted: amount,
      deductions
    };
  });

  const result = transaction();

  logOperation('points_batch_deduct', operator, memberId, null,
    `FIFO扣减积分 ${amount}，类型: ${deductionType}，原因: ${reason}`);

  return result;
};

const refundPointsToBatch = (batchId, amount, reason, { relatedNo = null, operator = 'system' } = {}) => {
  if (amount <= 0) {
    throw new Error('退回积分数量必须大于0');
  }

  const batch = getBatchById(batchId);
  if (!batch) {
    throw new Error('积分批次不存在');
  }

  const now = Date.now();
  const deductionNo = generateDeductionNo();

  const transaction = db.transaction(() => {
    const insertDeductionStmt = db.prepare(`
      INSERT INTO points_batch_deductions
      (batch_id, member_id, deduction_no, amount, deduction_type, related_no, reason, created_at)
      VALUES (?, ?, ?, ?, 'refund', ?, ?, ?)
    `);
    insertDeductionStmt.run(
      batch.id, batch.member_id, deductionNo, -amount, relatedNo, reason, now
    );

    const newRemaining = batch.remaining_amount + amount;
    const newStatus = batch.status === 'used_up' ? 'partially_used' : batch.status;

    const updateBatchStmt = db.prepare(`
      UPDATE points_batches
      SET remaining_amount = ?, status = ?, updated_at = ?
      WHERE id = ?
    `);
    updateBatchStmt.run(newRemaining, newStatus, now, batch.id);

    return {
      batch_id: batch.id,
      batch_no: batch.batch_no,
      refunded_amount: amount,
      new_remaining: newRemaining,
      deduction_no: deductionNo
    };
  });

  const result = transaction();

  logOperation('points_batch_refund', operator, batch.member_id, null,
    `退回积分 ${amount} 到批次 ${batch.batch_no}，原因: ${reason}`);

  return result;
};

const expireBatch = (batchId, operator = 'system') => {
  const batch = getBatchById(batchId);
  if (!batch) {
    throw new Error('积分批次不存在');
  }
  if (batch.status === 'expired') {
    throw new Error('该批次已过期');
  }
  if (batch.remaining_amount <= 0) {
    throw new Error('该批次无剩余积分');
  }

  const member = getMemberById(batch.member_id);
  if (!member) {
    throw new Error('会员不存在');
  }

  const expiredAmount = batch.remaining_amount;
  const now = Date.now();
  const deductionNo = generateDeductionNo();
  const transactionNo = generateTransactionNo('TXN');

  const transaction = db.transaction(() => {
    const newPoints = member.points - expiredAmount;
    if (newPoints < 0) {
      throw new Error('会员积分不足，无法过期');
    }

    const updateMemberStmt = db.prepare(`
      UPDATE members SET points = ?, updated_at = ? WHERE id = ?
    `);
    updateMemberStmt.run(newPoints, now, batch.member_id);

    const insertTransactionStmt = db.prepare(`
      INSERT INTO points_transactions
      (member_id, transaction_no, type, amount, balance_after, frozen_after, reason, operator, created_at)
      VALUES (?, ?, 'expire', ?, ?, ?, '积分过期', ?, ?)
    `);
    insertTransactionStmt.run(
      batch.member_id, transactionNo, -expiredAmount,
      newPoints, member.frozen_points, operator, now
    );

    const insertDeductionStmt = db.prepare(`
      INSERT INTO points_batch_deductions
      (batch_id, member_id, deduction_no, amount, deduction_type, related_no, reason, created_at)
      VALUES (?, ?, ?, ?, 'expire', ?, '积分过期', ?)
    `);
    insertDeductionStmt.run(
      batch.id, batch.member_id, deductionNo, expiredAmount, transactionNo, now
    );

    const updateBatchStmt = db.prepare(`
      UPDATE points_batches
      SET remaining_amount = 0, status = 'expired', updated_at = ?
      WHERE id = ?
    `);
    updateBatchStmt.run(now, batch.id);

    return {
      batch_id: batch.id,
      batch_no: batch.batch_no,
      expired_amount: expiredAmount,
      deduction_no: deductionNo,
      transaction_no: transactionNo,
      new_balance: newPoints
    };
  });

  const result = transaction();

  logOperation('points_batch_expire', operator, batch.member_id, null,
    `积分批次 ${batch.batch_no} 过期，过期积分数: ${expiredAmount}，交易号: ${transactionNo}`);

  return result;
};

const processExpiredBatches = (operator = 'system') => {
  const now = Date.now();

  const expiredBatches = db.prepare(`
    SELECT * FROM points_batches
    WHERE status IN ('active', 'partially_used')
      AND remaining_amount > 0
      AND expire_at IS NOT NULL
      AND expire_at <= ?
    ORDER BY expire_at ASC
  `).all(now);

  const results = [];
  for (const batch of expiredBatches) {
    try {
      const result = expireBatch(batch.id, operator);
      results.push(result);
    } catch (e) {
      // 跳过处理单个失败的批次
    }
  }

  return {
    processed_count: results.length,
    total_expired_points: results.reduce((sum, r) => sum + r.expired_amount, 0),
    results
  };
};

const getBatchDeductions = (batchId, { offset = 0, limit = 100 } = {}) => {
  return db.prepare(`
    SELECT * FROM points_batch_deductions
    WHERE batch_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(batchId, limit, offset);
};

const getMemberBatchDeductions = (memberId, { deductionType, offset = 0, limit = 100 } = {}) => {
  let sql = 'SELECT * FROM points_batch_deductions WHERE member_id = ?';
  const params = [memberId];

  if (deductionType) {
    sql += ' AND deduction_type = ?';
    params.push(deductionType);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const getExpiringBatches = (memberId, hours = 24) => {
  const now = Date.now();
  const expireThreshold = now + hours * 60 * 60 * 1000;

  return db.prepare(`
    SELECT * FROM points_batches
    WHERE member_id = ?
      AND status IN ('active', 'partially_used')
      AND remaining_amount > 0
      AND expire_at IS NOT NULL
      AND expire_at <= ?
      AND expire_at > ?
    ORDER BY expire_at ASC
  `).all(memberId, expireThreshold, now);
};

module.exports = {
  createBatch,
  getBatchById,
  getBatchByNo,
  listBatches,
  getAvailableBatchesForSpend,
  getTotalAvailablePoints,
  deductPointsByFifo,
  refundPointsToBatch,
  expireBatch,
  processExpiredBatches,
  getBatchDeductions,
  getMemberBatchDeductions,
  getExpiringBatches
};
