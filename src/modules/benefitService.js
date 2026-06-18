const { db, logOperation, generateTransactionNo } = require('../db');
const { VALID_LEVELS } = require('./memberService');

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

const getBenefitById = (id) => {
  return db.prepare('SELECT * FROM benefits WHERE id = ?').get(id);
};

const getBenefitByCode = (benefitCode) => {
  return db.prepare('SELECT * FROM benefits WHERE benefit_code = ?').get(benefitCode);
};

const listBenefits = ({ status, minLevel, offset = 0, limit = 100 } = {}) => {
  let sql = 'SELECT * FROM benefits WHERE 1=1';
  const params = [];

  if (status) {
    if (!['active', 'inactive', 'sold_out'].includes(status)) {
      throw new Error('无效的权益状态');
    }
    sql += ' AND status = ?';
    params.push(status);
  }
  if (minLevel) {
    if (!VALID_LEVELS.includes(minLevel)) {
      throw new Error('无效的会员等级');
    }
    sql += ' AND min_level = ?';
    params.push(minLevel);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const updateBenefitStock = (benefitId, stockChange, operator = 'system', reason = '') => {
  const benefit = getBenefitById(benefitId);
  if (!benefit) {
    throw new Error('权益不存在');
  }

  const newAvailableStock = benefit.available_stock + stockChange;
  const newTotalStock = benefit.total_stock + stockChange;

  if (newAvailableStock < 0) {
    throw new Error('可用库存不能为负数');
  }
  if (newTotalStock < 0) {
    throw new Error('总库存不能为负数');
  }

  const transaction = db.transaction(() => {
    const newStatus = newAvailableStock > 0 && benefit.status !== 'inactive' ? 'active' : 
                      newAvailableStock === 0 ? 'sold_out' : benefit.status;

    const stmt = db.prepare(`
      UPDATE benefits 
      SET total_stock = ?, available_stock = ?, status = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(newTotalStock, newAvailableStock, newStatus, Date.now(), benefitId);

    logOperation('benefit_stock_update', operator, null, benefitId, 
      `权益 ${benefit.name} 库存变动 ${stockChange > 0 ? '+' : ''}${stockChange}，${reason || '库存调整'}`);

    return getBenefitById(benefitId);
  });

  return transaction();
};

const updateBenefitStatus = (benefitId, status, operator = 'system') => {
  if (!['active', 'inactive', 'sold_out'].includes(status)) {
    throw new Error('无效的权益状态');
  }

  const benefit = getBenefitById(benefitId);
  if (!benefit) {
    throw new Error('权益不存在');
  }

  if (status === 'active' && benefit.available_stock <= 0) {
    throw new Error('库存为0的权益不能激活');
  }

  const stmt = db.prepare(`
    UPDATE benefits SET status = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(status, Date.now(), benefitId);

  logOperation('benefit_status_update', operator, null, benefitId, 
    `权益 ${benefit.name} 状态从 ${benefit.status} 变更为 ${status}`);

  return getBenefitById(benefitId);
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
  return { canRedeem: true, reason: null, benefit };
};

module.exports = {
  createBenefit,
  getBenefitById,
  getBenefitByCode,
  listBenefits,
  updateBenefitStock,
  updateBenefitStatus,
  getExpiringBenefits,
  checkLevelPermission,
  canRedeemBenefit
};
