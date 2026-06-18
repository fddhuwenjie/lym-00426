const { db, logOperation, generateTransactionNo } = require('../db');
const { getMemberById } = require('./memberService');
const { getBenefitById } = require('./benefitService');
const { refundPoints } = require('./pointsService');
const { refundPointsToBatch } = require('./pointsBatchService');

const generateCouponCode = () => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `CPN${timestamp}${random}`;
};

const createCoupon = (redemptionId, memberId, benefitId, pointsCost, {
  expireAt = null,
  operator = 'system'
} = {}) => {
  const redemption = db.prepare(`
    SELECT * FROM redemptions WHERE id = ?
  `).get(redemptionId);
  if (!redemption) {
    throw new Error('兑换记录不存在');
  }
  if (redemption.status !== 'success') {
    throw new Error('只有成功的兑换才能生成券码');
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const benefit = getBenefitById(benefitId);
  if (!benefit) {
    throw new Error('权益不存在');
  }

  const now = Date.now();
  const couponCode = generateCouponCode();

  const stmt = db.prepare(`
    INSERT INTO coupons
    (coupon_code, redemption_id, member_id, benefit_id, points_cost,
     status, expire_at, operator, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  const result = stmt.run(
    couponCode, redemptionId, memberId, benefitId, pointsCost,
    expireAt, operator, now, now
  );

  logOperation('coupon_create', operator, memberId, benefitId,
    `生成券码 ${couponCode}，兑换单号: ${redemption.redemption_no}，权益: ${benefit.name}`);

  return getCouponById(result.lastInsertRowid);
};

const getCouponById = (id) => {
  return db.prepare(`
    SELECT c.*, m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name,
           r.redemption_no
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    LEFT JOIN benefits b ON c.benefit_id = b.id
    LEFT JOIN redemptions r ON c.redemption_id = r.id
    WHERE c.id = ?
  `).get(id);
};

const getCouponByCode = (couponCode) => {
  return db.prepare(`
    SELECT c.*, m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name,
           r.redemption_no
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    LEFT JOIN benefits b ON c.benefit_id = b.id
    LEFT JOIN redemptions r ON c.redemption_id = r.id
    WHERE c.coupon_code = ?
  `).get(couponCode);
};

const listCoupons = ({ memberId, benefitId, status, redemptionId, startTime, endTime, offset = 0, limit = 100 } = {}) => {
  let sql = `
    SELECT c.*, m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name,
           r.redemption_no
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    LEFT JOIN benefits b ON c.benefit_id = b.id
    LEFT JOIN redemptions r ON c.redemption_id = r.id
    WHERE 1=1
  `;
  const params = [];

  if (memberId) {
    sql += ' AND c.member_id = ?';
    params.push(memberId);
  }
  if (benefitId) {
    sql += ' AND c.benefit_id = ?';
    params.push(benefitId);
  }
  if (status) {
    sql += ' AND c.status = ?';
    params.push(status);
  }
  if (redemptionId) {
    sql += ' AND c.redemption_id = ?';
    params.push(redemptionId);
  }
  if (startTime) {
    sql += ' AND c.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND c.created_at <= ?';
    params.push(endTime);
  }

  sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const getCouponsByRedemption = (redemptionId) => {
  return db.prepare(`
    SELECT c.*, m.member_no, m.name as member_name,
           b.benefit_code, b.name as benefit_name
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    LEFT JOIN benefits b ON c.benefit_id = b.id
    WHERE c.redemption_id = ?
    ORDER BY c.created_at DESC
  `).all(redemptionId);
};

const redeemCoupon = (couponCode, operator = 'system') => {
  const coupon = getCouponByCode(couponCode);
  if (!coupon) {
    throw new Error('券码不存在');
  }

  if (coupon.status === 'used') {
    throw new Error('券码已核销，不能重复核销');
  }
  if (coupon.status === 'voided') {
    throw new Error('券码已作废，不能核销');
  }
  if (coupon.status === 'expired') {
    throw new Error('券码已过期，不能核销');
  }

  if (coupon.expire_at && coupon.expire_at < Date.now() && coupon.status === 'pending') {
    expireCoupon(coupon.id, operator);
    throw new Error('券码已过期，不能核销');
  }

  const transaction = db.transaction(() => {
    const now = Date.now();
    const updateStmt = db.prepare(`
      UPDATE coupons SET status = 'used', used_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = updateStmt.run(now, now, coupon.id);

    if (result.changes === 0) {
      throw new Error('券码状态已变更，核销失败');
    }
  });

  transaction();

  logOperation('coupon_redeem', operator, coupon.member_id, coupon.benefit_id,
    `券码 ${couponCode} 核销成功，权益: ${coupon.benefit_name}`);

  return getCouponById(coupon.id);
};

const voidCoupon = (couponCode, reason = '', operator = 'system') => {
  const coupon = getCouponByCode(couponCode);
  if (!coupon) {
    throw new Error('券码不存在');
  }

  if (coupon.status === 'used') {
    throw new Error('已核销的券码不能作废');
  }
  if (coupon.status === 'voided') {
    throw new Error('券码已作废');
  }
  if (coupon.status === 'expired') {
    throw new Error('已过期的券码不能作废，请使用过期退回');
  }

  const transaction = db.transaction(() => {
    const now = Date.now();
    const updateStmt = db.prepare(`
      UPDATE coupons SET status = 'voided', voided_at = ?, void_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = updateStmt.run(now, reason || '券码作废', now, coupon.id);

    if (result.changes === 0) {
      throw new Error('券码状态已变更，作废失败');
    }

    refundPoints(coupon.member_id, coupon.points_cost,
      `券码作废退回积分: ${couponCode}`, operator);

    const deductions = db.prepare(`
      SELECT * FROM points_batch_deductions
      WHERE deduction_type = 'spend' AND related_no = ?
      ORDER BY created_at ASC
    `).all(coupon.redemption_no);

    for (const deduction of deductions) {
      refundPointsToBatch(deduction.batch_id, deduction.amount,
        `券码作废退回: ${couponCode}`, {
        relatedNo: couponCode,
        operator
      });
    }
  });

  transaction();

  logOperation('coupon_void', operator, coupon.member_id, coupon.benefit_id,
    `券码 ${couponCode} 作废，退回积分 ${coupon.points_cost}，原因: ${reason || '券码作废'}`);

  return getCouponById(coupon.id);
};

const expireCoupon = (couponId, operator = 'system') => {
  const coupon = getCouponById(couponId);
  if (!coupon) {
    throw new Error('券码不存在');
  }

  if (coupon.status !== 'pending') {
    throw new Error('只有待核销的券码才能过期');
  }

  const transaction = db.transaction(() => {
    const now = Date.now();
    const updateStmt = db.prepare(`
      UPDATE coupons SET status = 'expired', expired_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    const result = updateStmt.run(now, now, couponId);

    if (result.changes === 0) {
      throw new Error('券码状态已变更，过期处理失败');
    }

    refundPoints(coupon.member_id, coupon.points_cost,
      `券码过期退回积分: ${coupon.coupon_code}`, operator);

    const deductions = db.prepare(`
      SELECT * FROM points_batch_deductions
      WHERE deduction_type = 'spend' AND related_no = ?
      ORDER BY created_at ASC
    `).all(coupon.redemption_no);

    for (const deduction of deductions) {
      refundPointsToBatch(deduction.batch_id, deduction.amount,
        `券码过期退回: ${coupon.coupon_code}`, {
        relatedNo: coupon.coupon_code,
        operator
      });
    }
  });

  transaction();

  logOperation('coupon_expire', operator, coupon.member_id, coupon.benefit_id,
    `券码 ${coupon.coupon_code} 过期，退回积分 ${coupon.points_cost}`);

  return getCouponById(couponId);
};

const processExpiredCoupons = (operator = 'system') => {
  const now = Date.now();

  const expiredCoupons = db.prepare(`
    SELECT * FROM coupons
    WHERE status = 'pending'
      AND expire_at IS NOT NULL
      AND expire_at <= ?
    ORDER BY expire_at ASC
  `).all(now);

  const results = [];
  for (const coupon of expiredCoupons) {
    try {
      const result = expireCoupon(coupon.id, operator);
      results.push(result);
    } catch (e) {
      // 跳过处理单个失败的券码
    }
  }

  return {
    processed_count: results.length,
    total_refunded_points: results.reduce((sum, r) => sum + r.points_cost, 0),
    results
  };
};

const getCouponStats = ({ memberId, benefitId, startTime, endTime, memberLevel } = {}) => {
  let sql = `
    SELECT 
      COUNT(*) as total_count,
      SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) as used_count,
      SUM(CASE WHEN c.status = 'voided' THEN 1 ELSE 0 END) as voided_count,
      SUM(CASE WHEN c.status = 'expired' THEN 1 ELSE 0 END) as expired_count,
      SUM(CASE WHEN c.status = 'used' THEN c.points_cost ELSE 0 END) as consumed_points,
      SUM(CASE WHEN c.status IN ('voided', 'expired') THEN c.points_cost ELSE 0 END) as refunded_points
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (memberId) {
    sql += ' AND c.member_id = ?';
    params.push(memberId);
  }
  if (benefitId) {
    sql += ' AND c.benefit_id = ?';
    params.push(benefitId);
  }
  if (startTime) {
    sql += ' AND c.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND c.created_at <= ?';
    params.push(endTime);
  }
  if (memberLevel) {
    sql += ' AND m.level = ?';
    params.push(memberLevel);
  }

  return db.prepare(sql).get(...params);
};

module.exports = {
  createCoupon,
  getCouponById,
  getCouponByCode,
  listCoupons,
  getCouponsByRedemption,
  redeemCoupon,
  voidCoupon,
  expireCoupon,
  processExpiredCoupons,
  getCouponStats
};
