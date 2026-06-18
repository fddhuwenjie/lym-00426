const { db } = require('../db');
const { getDayStart, getDayEnd } = require('./riskControlService');

const getSettlementStats = ({ startTime, endTime, memberLevel, benefitType, benefitId } = {}) => {
  let sql = `
    SELECT 
      COUNT(*) as total_coupons,
      SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending_coupons,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) as used_coupons,
      SUM(CASE WHEN c.status = 'voided' THEN 1 ELSE 0 END) as voided_coupons,
      SUM(CASE WHEN c.status = 'expired' THEN 1 ELSE 0 END) as expired_coupons,
      SUM(CASE WHEN c.status = 'used' THEN c.points_cost ELSE 0 END) as consumed_points,
      SUM(CASE WHEN c.status IN ('voided', 'expired') THEN c.points_cost ELSE 0 END) as refunded_points,
      SUM(c.points_cost) as total_points
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    LEFT JOIN benefits b ON c.benefit_id = b.id
    WHERE 1=1
  `;
  const params = [];

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
  if (benefitId) {
    sql += ' AND c.benefit_id = ?';
    params.push(benefitId);
  }
  if (benefitType) {
    sql += ' AND b.benefit_code LIKE ?';
    params.push(`%${benefitType}%`);
  }

  return db.prepare(sql).get(...params);
};

const getSettlementByMemberLevel = ({ startTime, endTime } = {}) => {
  let sql = `
    SELECT 
      m.level as member_level,
      COUNT(*) as total_coupons,
      SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending_coupons,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) as used_coupons,
      SUM(CASE WHEN c.status = 'voided' THEN 1 ELSE 0 END) as voided_coupons,
      SUM(CASE WHEN c.status = 'expired' THEN 1 ELSE 0 END) as expired_coupons,
      SUM(CASE WHEN c.status = 'used' THEN c.points_cost ELSE 0 END) as consumed_points,
      SUM(CASE WHEN c.status IN ('voided', 'expired') THEN c.points_cost ELSE 0 END) as refunded_points
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (startTime) {
    sql += ' AND c.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND c.created_at <= ?';
    params.push(endTime);
  }

  sql += ' GROUP BY m.level ORDER BY m.level';

  return db.prepare(sql).all(...params);
};

const getSettlementByBenefit = ({ startTime, endTime, memberLevel } = {}) => {
  let sql = `
    SELECT 
      b.id as benefit_id,
      b.benefit_code,
      b.name as benefit_name,
      COUNT(*) as total_coupons,
      SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending_coupons,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) as used_coupons,
      SUM(CASE WHEN c.status = 'voided' THEN 1 ELSE 0 END) as voided_coupons,
      SUM(CASE WHEN c.status = 'expired' THEN 1 ELSE 0 END) as expired_coupons,
      SUM(CASE WHEN c.status = 'used' THEN c.points_cost ELSE 0 END) as consumed_points,
      SUM(CASE WHEN c.status IN ('voided', 'expired') THEN c.points_cost ELSE 0 END) as refunded_points
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    LEFT JOIN benefits b ON c.benefit_id = b.id
    WHERE 1=1
  `;
  const params = [];

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

  sql += ' GROUP BY b.id ORDER BY total_coupons DESC';

  return db.prepare(sql).all(...params);
};

const getSettlementByDate = ({ startTime, endTime, memberLevel, benefitId } = {}) => {
  let sql = `
    SELECT 
      DATE(c.created_at / 1000, 'unixepoch', 'localtime') as stat_date,
      COUNT(*) as total_coupons,
      SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending_coupons,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) as used_coupons,
      SUM(CASE WHEN c.status = 'voided' THEN 1 ELSE 0 END) as voided_coupons,
      SUM(CASE WHEN c.status = 'expired' THEN 1 ELSE 0 END) as expired_coupons,
      SUM(CASE WHEN c.status = 'used' THEN c.points_cost ELSE 0 END) as consumed_points,
      SUM(CASE WHEN c.status IN ('voided', 'expired') THEN c.points_cost ELSE 0 END) as refunded_points
    FROM coupons c
    LEFT JOIN members m ON c.member_id = m.id
    WHERE 1=1
  `;
  const params = [];

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
  if (benefitId) {
    sql += ' AND c.benefit_id = ?';
    params.push(benefitId);
  }

  sql += ' GROUP BY stat_date ORDER BY stat_date DESC';

  return db.prepare(sql).all(...params);
};

const getPointsSettlementStats = ({ startTime, endTime, memberLevel } = {}) => {
  let sql = `
    SELECT 
      SUM(CASE WHEN pt.type = 'earn' THEN pt.amount ELSE 0 END) as total_earned_points,
      SUM(CASE WHEN pt.type = 'spend' THEN ABS(pt.amount) ELSE 0 END) as total_spent_points,
      SUM(CASE WHEN pt.type = 'expire' THEN ABS(pt.amount) ELSE 0 END) as total_expired_points,
      SUM(CASE WHEN pt.type = 'refund' THEN pt.amount ELSE 0 END) as total_refunded_points
    FROM points_transactions pt
    LEFT JOIN members m ON pt.member_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (startTime) {
    sql += ' AND pt.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND pt.created_at <= ?';
    params.push(endTime);
  }
  if (memberLevel) {
    sql += ' AND m.level = ?';
    params.push(memberLevel);
  }

  return db.prepare(sql).get(...params);
};

const getRiskControlSettlement = ({ startTime, endTime, memberLevel, ruleType } = {}) => {
  let sql = `
    SELECT 
      COUNT(*) as total_records,
      SUM(CASE WHEN rcr.status = 'blocked' THEN 1 ELSE 0 END) as blocked_count,
      SUM(CASE WHEN rcr.status = 'reviewed' THEN 1 ELSE 0 END) as reviewed_count,
      SUM(CASE WHEN rcr.status = 'released' THEN 1 ELSE 0 END) as released_count,
      rcr.rule_type,
      rcr.rule_code
    FROM risk_control_records rcr
    LEFT JOIN members m ON rcr.member_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (startTime) {
    sql += ' AND rcr.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND rcr.created_at <= ?';
    params.push(endTime);
  }
  if (memberLevel) {
    sql += ' AND m.level = ?';
    params.push(memberLevel);
  }
  if (ruleType) {
    sql += ' AND rcr.rule_type = ?';
    params.push(ruleType);
  }

  sql += ' GROUP BY rcr.rule_type, rcr.rule_code ORDER BY total_records DESC';

  return db.prepare(sql).all(...params);
};

const getFullSettlementReport = ({ startTime, endTime } = {}) => {
  const start = startTime || getDayStart(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = endTime || getDayEnd();

  const couponStats = getSettlementStats({ startTime: start, endTime: end });
  const byMemberLevel = getSettlementByMemberLevel({ startTime: start, endTime: end });
  const byBenefit = getSettlementByBenefit({ startTime: start, endTime: end });
  const byDate = getSettlementByDate({ startTime: start, endTime: end });
  const pointsStats = getPointsSettlementStats({ startTime: start, endTime: end });
  const riskStats = getRiskControlSettlement({ startTime: start, endTime: end });

  return {
    period: { start_time: start, end_time: end },
    coupon_summary: couponStats,
    points_summary: pointsStats,
    by_member_level: byMemberLevel,
    by_benefit: byBenefit,
    by_date: byDate,
    risk_control_summary: riskStats
  };
};

module.exports = {
  getSettlementStats,
  getSettlementByMemberLevel,
  getSettlementByBenefit,
  getSettlementByDate,
  getPointsSettlementStats,
  getRiskControlSettlement,
  getFullSettlementReport
};
