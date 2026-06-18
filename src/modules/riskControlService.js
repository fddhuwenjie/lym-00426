const { db, logOperation, generateTransactionNo } = require('../db');
const { getMemberById, VALID_LEVELS } = require('./memberService');
const { getBenefitById } = require('./benefitService');
const { getTotalAvailablePoints } = require('./pointsBatchService');

const generateRecordNo = () => generateTransactionNo('RCR');

const LEVEL_ORDER = { normal: 0, silver: 1, gold: 2, platinum: 3 };

const createRule = (ruleCode, ruleName, ruleType, {
  minLevel = 'normal',
  maxDailyRedemptions = null,
  maxDailyPoints = null,
  sameBenefitIntervalHours = null,
  description = '',
  operator = 'system'
} = {}) => {
  if (!ruleCode || ruleCode.trim() === '') {
    throw new Error('规则编码不能为空');
  }
  if (!ruleName || ruleName.trim() === '') {
    throw new Error('规则名称不能为空');
  }
  if (!['level', 'daily_count', 'daily_points', 'same_benefit_interval', 'account_status'].includes(ruleType)) {
    throw new Error('无效的规则类型');
  }
  if (!VALID_LEVELS.includes(minLevel)) {
    throw new Error('无效的最低会员等级');
  }

  const existing = db.prepare('SELECT id FROM risk_control_rules WHERE rule_code = ?').get(ruleCode);
  if (existing) {
    throw new Error('规则编码已存在');
  }

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO risk_control_rules
    (rule_code, rule_name, rule_type, min_level, max_daily_redemptions, max_daily_points,
     same_benefit_interval_hours, status, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const result = stmt.run(
    ruleCode, ruleName, ruleType, minLevel, maxDailyRedemptions, maxDailyPoints,
    sameBenefitIntervalHours, description, now, now
  );

  logOperation('risk_rule_create', operator, null, null,
    `创建风控规则: ${ruleName}，编码: ${ruleCode}，类型: ${ruleType}`);

  return getRuleById(result.lastInsertRowid);
};

const getRuleById = (id) => {
  return db.prepare('SELECT * FROM risk_control_rules WHERE id = ?').get(id);
};

const getRuleByCode = (ruleCode) => {
  return db.prepare('SELECT * FROM risk_control_rules WHERE rule_code = ?').get(ruleCode);
};

const listRules = ({ status, ruleType, offset = 0, limit = 100 } = {}) => {
  let sql = 'SELECT * FROM risk_control_rules WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (ruleType) {
    sql += ' AND rule_type = ?';
    params.push(ruleType);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const updateRuleStatus = (ruleId, status, operator = 'system') => {
  if (!['active', 'inactive'].includes(status)) {
    throw new Error('无效的规则状态');
  }

  const rule = getRuleById(ruleId);
  if (!rule) {
    throw new Error('风控规则不存在');
  }

  const stmt = db.prepare('UPDATE risk_control_rules SET status = ?, updated_at = ? WHERE id = ?');
  stmt.run(status, Date.now(), ruleId);

  logOperation('risk_rule_status_update', operator, null, null,
    `风控规则 ${rule.rule_name} 状态从 ${rule.status} 变更为 ${status}`);

  return getRuleById(ruleId);
};

const getActiveRules = () => {
  return db.prepare(`
    SELECT * FROM risk_control_rules
    WHERE status = 'active'
    ORDER BY rule_type, min_level
  `).all();
};

const createRiskRecord = (memberId, benefitId, rule, hitReason, hitValue, thresholdValue, operator = 'system') => {
  const recordNo = generateRecordNo();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO risk_control_records
    (record_no, member_id, benefit_id, rule_id, rule_code, rule_type,
     hit_reason, hit_value, threshold_value, status, operator, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?)
  `);
  const result = stmt.run(
    recordNo, memberId, benefitId || null, rule ? rule.id : null,
    rule ? rule.rule_code : 'unknown', rule ? rule.rule_type : 'unknown',
    hitReason, hitValue || null, thresholdValue || null, operator, now
  );

  logOperation('risk_record_create', operator, memberId, benefitId || null,
    `风控拦截: ${hitReason}，记录号: ${recordNo}，规则: ${rule ? rule.rule_code : 'unknown'}`);

  return getRiskRecordById(result.lastInsertRowid);
};

const getRiskRecordById = (id) => {
  return db.prepare(`
    SELECT rcr.*, m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name
    FROM risk_control_records rcr
    LEFT JOIN members m ON rcr.member_id = m.id
    LEFT JOIN benefits b ON rcr.benefit_id = b.id
    WHERE rcr.id = ?
  `).get(id);
};

const getRiskRecordByNo = (recordNo) => {
  return db.prepare(`
    SELECT rcr.*, m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name
    FROM risk_control_records rcr
    LEFT JOIN members m ON rcr.member_id = m.id
    LEFT JOIN benefits b ON rcr.benefit_id = b.id
    WHERE rcr.record_no = ?
  `).get(recordNo);
};

const listRiskRecords = ({ memberId, benefitId, ruleType, status, startTime, endTime, offset = 0, limit = 100 } = {}) => {
  let sql = `
    SELECT rcr.*, m.member_no, m.name as member_name, m.level as member_level,
           b.benefit_code, b.name as benefit_name
    FROM risk_control_records rcr
    LEFT JOIN members m ON rcr.member_id = m.id
    LEFT JOIN benefits b ON rcr.benefit_id = b.id
    WHERE 1=1
  `;
  const params = [];

  if (memberId) {
    sql += ' AND rcr.member_id = ?';
    params.push(memberId);
  }
  if (benefitId) {
    sql += ' AND rcr.benefit_id = ?';
    params.push(benefitId);
  }
  if (ruleType) {
    sql += ' AND rcr.rule_type = ?';
    params.push(ruleType);
  }
  if (status) {
    sql += ' AND rcr.status = ?';
    params.push(status);
  }
  if (startTime) {
    sql += ' AND rcr.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND rcr.created_at <= ?';
    params.push(endTime);
  }

  sql += ' ORDER BY rcr.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const getDayStart = (timestamp = Date.now()) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const getDayEnd = (timestamp = Date.now()) => {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
};

const getDailyRedemptionCount = (memberId) => {
  const dayStart = getDayStart();
  const dayEnd = getDayEnd();

  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM redemptions
    WHERE member_id = ?
      AND status = 'success'
      AND created_at >= ?
      AND created_at <= ?
  `).get(memberId, dayStart, dayEnd);

  return result.count;
};

const getDailySpentPoints = (memberId) => {
  const dayStart = getDayStart();
  const dayEnd = getDayEnd();

  const result = db.prepare(`
    SELECT COALESCE(SUM(points_cost), 0) as total
    FROM redemptions
    WHERE member_id = ?
      AND status = 'success'
      AND created_at >= ?
      AND created_at <= ?
  `).get(memberId, dayStart, dayEnd);

  return result.total;
};

const getLastRedemptionForBenefit = (memberId, benefitId) => {
  return db.prepare(`
    SELECT * FROM redemptions
    WHERE member_id = ?
      AND benefit_id = ?
      AND status = 'success'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(memberId, benefitId);
};

const checkRedemptionRisk = (memberId, benefitId, operator = 'system') => {
  const member = getMemberById(memberId);
  if (!member) {
    return { pass: false, reason: '会员不存在', rule: null };
  }

  const benefit = getBenefitById(benefitId);
  if (!benefit) {
    return { pass: false, reason: '权益不存在', rule: null };
  }

  const activeRules = getActiveRules();

  if (member.status !== 'active') {
    const statusRule = activeRules.find(r => r.rule_type === 'account_status');
    if (statusRule) {
      const record = createRiskRecord(memberId, benefitId, statusRule,
        '账号状态异常，无法兑换',
        member.status, 'active', operator);
      return {
        pass: false,
        reason: '账号状态异常',
        details: `当前账号状态为 ${member.status}，无法进行权益兑换`,
        rule: statusRule,
        record
      };
    }
  }

  const applicableRules = activeRules.filter(rule => {
    if (rule.min_level) {
      return LEVEL_ORDER[member.level] >= LEVEL_ORDER[rule.min_level];
    }
    return true;
  });

  for (const rule of applicableRules) {
    switch (rule.rule_type) {
      case 'daily_count':
        if (rule.max_daily_redemptions !== null) {
          const dailyCount = getDailyRedemptionCount(memberId);
          if (dailyCount >= rule.max_daily_redemptions) {
            const record = createRiskRecord(memberId, benefitId, rule,
              '超过单日兑换次数限制',
              dailyCount.toString(), rule.max_daily_redemptions.toString(), operator);
            return {
              pass: false,
              reason: '超过单日兑换次数限制',
              details: `今日已兑换 ${dailyCount} 次，上限为 ${rule.max_daily_redemptions} 次`,
              rule,
              record
            };
          }
        }
        break;

      case 'daily_points':
        if (rule.max_daily_points !== null) {
          const dailyPoints = getDailySpentPoints(memberId);
          const newTotal = dailyPoints + benefit.points_cost;
          if (newTotal > rule.max_daily_points) {
            const record = createRiskRecord(memberId, benefitId, rule,
              '超过单日消耗积分上限',
              newTotal.toString(), rule.max_daily_points.toString(), operator);
            return {
              pass: false,
              reason: '超过单日消耗积分上限',
              details: `今日已消耗 ${dailyPoints} 积分，本次兑换 ${benefit.points_cost} 积分，将超过上限 ${rule.max_daily_points} 积分`,
              rule,
              record
            };
          }
        }
        break;

      case 'same_benefit_interval':
        if (rule.same_benefit_interval_hours !== null) {
          const lastRedemption = getLastRedemptionForBenefit(memberId, benefitId);
          if (lastRedemption) {
            const intervalMs = rule.same_benefit_interval_hours * 60 * 60 * 1000;
            const timeSinceLast = Date.now() - lastRedemption.created_at;
            if (timeSinceLast < intervalMs) {
              const hoursLeft = Math.ceil((intervalMs - timeSinceLast) / (60 * 60 * 1000));
              const record = createRiskRecord(memberId, benefitId, rule,
                '同一权益兑换间隔不足',
                `${(timeSinceLast / (60 * 60 * 1000)).toFixed(1)}小时`,
                `${rule.same_benefit_interval_hours}小时`, operator);
              return {
                pass: false,
                reason: '同一权益兑换间隔不足',
                details: `距离上次兑换该权益不足 ${rule.same_benefit_interval_hours} 小时，请约 ${hoursLeft} 小时后再试`,
                rule,
                record
              };
            }
          }
        }
        break;
    }
  }

  return { pass: true, reason: null, details: null, rule: null };
};

const updateRiskRecordStatus = (recordId, status, operator = 'system') => {
  if (!['blocked', 'reviewed', 'released'].includes(status)) {
    throw new Error('无效的风控记录状态');
  }

  const record = db.prepare('SELECT * FROM risk_control_records WHERE id = ?').get(recordId);
  if (!record) {
    throw new Error('风控记录不存在');
  }

  const stmt = db.prepare('UPDATE risk_control_records SET status = ? WHERE id = ?');
  stmt.run(status, recordId);

  logOperation('risk_record_status_update', operator, record.member_id, record.benefit_id,
    `风控记录 ${record.record_no} 状态从 ${record.status} 变更为 ${status}`);

  return getRiskRecordById(recordId);
};

module.exports = {
  createRule,
  getRuleById,
  getRuleByCode,
  listRules,
  updateRuleStatus,
  getActiveRules,
  createRiskRecord,
  getRiskRecordById,
  getRiskRecordByNo,
  listRiskRecords,
  checkRedemptionRisk,
  updateRiskRecordStatus,
  getDailyRedemptionCount,
  getDailySpentPoints,
  getDayStart,
  getDayEnd
};
