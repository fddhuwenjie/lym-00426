const { db, logOperation, generateTransactionNo } = require('../db');
const { getMemberById } = require('./memberService');
const { createBatch, deductPointsByFifo } = require('./pointsBatchService');

const POINTS_SOURCE_DEFAULT = 'general';

const earnPoints = (memberId, amount, reason, operator = 'system', { source = POINTS_SOURCE_DEFAULT, expireAt = null } = {}) => {
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

    const batch = createBatch(memberId, amount, source, reason, {
      expireAt,
      transactionNo
    });

    logOperation('points_earn', operator, memberId, null, 
      `获取积分 ${amount}，原因: ${reason}，交易号: ${transactionNo}，批次号: ${batch.batch_no}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      balance_after: newPoints,
      type: 'earn',
      reason,
      source,
      expire_at: expireAt,
      batch_no: batch.batch_no,
      created_at: now
    };
  });

  return transaction();
};

const spendPoints = (memberId, amount, reason, operator = 'system', { relatedNo = null } = {}) => {
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

    const fifoResult = deductPointsByFifo(memberId, amount, 'spend', reason, {
      relatedNo,
      operator
    });

    logOperation('points_spend', operator, memberId, null, 
      `扣减积分 ${amount}，原因: ${reason}，交易号: ${transactionNo}，FIFO扣减批次: ${fifoResult.deductions.length}个`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      balance_after: newPoints,
      type: 'spend',
      reason,
      batch_deductions: fifoResult.deductions,
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

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
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

const getExpiringFrozenRecords = (hours = 24) => {
  const now = Date.now();
  const expireThreshold = now + hours * 60 * 60 * 1000;

  return db.prepare(`
    SELECT fr.*, m.member_no, m.name 
    FROM frozen_records fr
    JOIN members m ON fr.member_id = m.id
    WHERE fr.status = 'frozen' 
      AND fr.expire_at IS NOT NULL 
      AND fr.expire_at <= ? 
      AND fr.expire_at > ?
    ORDER BY fr.expire_at ASC
  `).all(expireThreshold, now);
};

const expirePoints = (memberId, amount, reason, operator = 'system') => {
  if (amount <= 0) {
    throw new Error('过期积分数量必须大于0');
  }
  if (!reason || reason.trim() === '') {
    throw new Error('必须提供过期原因');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }
  if (member.points < amount) {
    throw new Error('会员总积分不足，无法过期');
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
      VALUES (?, ?, 'expire', ?, ?, ?, ?, ?, ?)
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

    logOperation('points_expire', operator, memberId, null,
      `过期积分 ${amount}，原因: ${reason}，交易号: ${transactionNo}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      balance_after: newPoints,
      type: 'expire',
      reason,
      created_at: now
    };
  });

  return transaction();
};

const refundPoints = (memberId, amount, reason, operator = 'system') => {
  if (amount <= 0) {
    throw new Error('退回积分数量必须大于0');
  }
  if (!reason || reason.trim() === '') {
    throw new Error('必须提供退回原因');
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
      VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)
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

    logOperation('points_refund', operator, memberId, null,
      `退回积分 ${amount}，原因: ${reason}，交易号: ${transactionNo}`);

    return {
      transaction_no: transactionNo,
      member_id: memberId,
      amount,
      balance_after: newPoints,
      type: 'refund',
      reason,
      created_at: now
    };
  });

  return transaction();
};

module.exports = {
  earnPoints,
  spendPoints,
  freezePoints,
  unfreezePoints,
  expirePoints,
  refundPoints,
  getTransactionHistory,
  getFrozenRecords,
  getExpiringFrozenRecords
};
