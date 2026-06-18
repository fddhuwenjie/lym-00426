const { db } = require('../db');
const { VALID_LEVELS } = require('./memberService');

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

const getOperationTypes = () => {
  return db.prepare(`
    SELECT DISTINCT operation_type 
    FROM operation_logs 
    ORDER BY operation_type
  `).all().map(row => row.operation_type);
};

const getLogStats = ({
  operationType,
  memberLevel,
  startTime,
  endTime
} = {}) => {
  let sql = `
    SELECT 
      COUNT(*) as total_count,
      ol.operation_type,
      m.level as member_level
    FROM operation_logs ol
    LEFT JOIN members m ON ol.member_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (operationType) {
    sql += ' AND ol.operation_type = ?';
    params.push(operationType);
  }
  if (memberLevel) {
    if (!VALID_LEVELS.includes(memberLevel)) {
      throw new Error(`无效的会员等级`);
    }
    sql += ' AND m.level = ?';
    params.push(memberLevel);
  }
  if (startTime) {
    sql += ' AND ol.created_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND ol.created_at <= ?';
    params.push(endTime);
  }

  sql += ' GROUP BY ol.operation_type, m.level ORDER BY total_count DESC';

  return db.prepare(sql).all(...params);
};

module.exports = {
  listOperationLogs,
  getOperationTypes,
  getLogStats
};
