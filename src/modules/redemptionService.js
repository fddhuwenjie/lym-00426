const { db, logOperation, generateTransactionNo } = require('../db');
const { getMemberById, getMemberPointsInfo } = require('./memberService');
const { getBenefitById, canRedeemBenefit, checkLevelPermission } = require('./benefitService');
const { spendPoints } = require('./pointsService');

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

const getRedemptionById = (id) => {
  return db.prepare(`
    SELECT r.*, m.member_no, m.name as member_name, b.name as benefit_name, b.benefit_code
    FROM redemptions r
    JOIN members m ON r.member_id = m.id
    JOIN benefits b ON r.benefit_id = b.id
    WHERE r.id = ?
  `).get(id);
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

const getRedemptionStats = (benefitId = null, startTime = null, endTime = null) => {
  let sql = `
    SELECT 
      COUNT(*) as total_count,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status = 'success' THEN points_cost ELSE 0 END) as total_points_spent
    FROM redemptions
    WHERE 1=1
  `;
  const params = [];

  if (benefitId) {
    sql += ' AND benefit_id = ?';
    params.push(benefitId);
  }
  if (startTime) {
    sql += ' AND created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND created_at <= ?';
    params.push(endTime);
  }

  return db.prepare(sql).get(...params);
};

module.exports = {
  redeemBenefit,
  getRedemptionById,
  getRedemptionByNo,
  listRedemptions,
  getRedemptionStats
};
