const { db, logOperation, generateTransactionNo } = require('../db');
const { processMemberExpiredBatches, getTotalAvailablePoints } = require('./pointsBatchService');

const VALID_LEVELS = ['normal', 'silver', 'gold', 'platinum'];
const VALID_STATUSES = ['active', 'frozen'];

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

const getMemberById = (id) => {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id);
};

const getMemberByNo = (memberNo) => {
  return db.prepare('SELECT * FROM members WHERE member_no = ?').get(memberNo);
};

const listMembers = ({ level, status, offset = 0, limit = 100 } = {}) => {
  let sql = 'SELECT * FROM members WHERE 1=1';
  const params = [];

  if (level) {
    if (!VALID_LEVELS.includes(level)) {
      throw new Error(`无效的会员等级`);
    }
    sql += ' AND level = ?';
    params.push(level);
  }
  if (status) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`无效的会员状态`);
    }
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
};

const updateMemberLevel = (memberId, level, operator = 'system') => {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`无效的会员等级`);
  }

  const member = getMemberById(memberId);
  if (!member) {
    throw new Error('会员不存在');
  }

  const stmt = db.prepare('UPDATE members SET level = ?, updated_at = ? WHERE id = ?');
  stmt.run(level, Date.now(), memberId);

  logOperation('member_level_update', operator, memberId, null, `等级从 ${member.level} 变更为 ${level}`);

  return getMemberById(memberId);
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

  processMemberExpiredBatches(memberId);

  const memberAfter = getMemberById(memberId);

  const frozenRecords = db.prepare(`
    SELECT * FROM frozen_records 
    WHERE member_id = ? AND status = 'frozen'
    ORDER BY created_at DESC
  `).all(memberId);

  const realAvailablePoints = getTotalAvailablePoints(memberId);
  const availablePoints = realAvailablePoints - memberAfter.frozen_points;

  return {
    member_id: memberAfter.id,
    member_no: memberAfter.member_no,
    name: memberAfter.name,
    level: memberAfter.level,
    status: memberAfter.status,
    total_points: memberAfter.points,
    frozen_points: memberAfter.frozen_points,
    available_points: availablePoints >= 0 ? availablePoints : 0,
    frozen_records: frozenRecords
  };
};

module.exports = {
  registerMember,
  getMemberById,
  getMemberByNo,
  listMembers,
  updateMemberLevel,
  freezeMember,
  unfreezeMember,
  getMemberPointsInfo,
  VALID_LEVELS,
  VALID_STATUSES
};
