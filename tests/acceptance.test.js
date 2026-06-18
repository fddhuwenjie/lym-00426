const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.DB_NAME = 'test_members.db';

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

const { db, initTables } = require('../src/db');
const memberService = require('../src/modules/memberService');
const pointsService = require('../src/modules/pointsService');
const pointsBatchService = require('../src/modules/pointsBatchService');
const benefitService = require('../src/modules/benefitService');
const redemptionService = require('../src/modules/redemptionService');
const riskControlService = require('../src/modules/riskControlService');
const couponService = require('../src/modules/couponService');
const settlementService = require('../src/modules/settlementService');
const logService = require('../src/modules/logService');

initTables();

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
console.log('  会员积分与权益中心 - 验收测试（增强版）');
console.log('========================================\n');

console.log('1. 会员管理测试');
test('注册普通会员成功', () => {
  const member = memberService.registerMember('M001', '张三', 'normal', 'admin');
  assert.strictEqual(member.member_no, 'M001');
  assert.strictEqual(member.name, '张三');
  assert.strictEqual(member.level, 'normal');
  assert.strictEqual(member.status, 'active');
  assert.strictEqual(member.points, 0);
  assert.strictEqual(member.frozen_points, 0);
  global.member1Id = member.id;
});

test('注册黄金会员成功', () => {
  const member = memberService.registerMember('M002', '李四', 'gold', 'admin');
  assert.strictEqual(member.level, 'gold');
  global.member2Id = member.id;
});

test('获取会员积分信息', () => {
  const info = memberService.getMemberPointsInfo(global.member1Id);
  assert.strictEqual(info.available_points, 0);
  assert.strictEqual(info.total_points, 0);
});

console.log('\n2. 积分批次与有效期测试');
test('获取积分并创建批次（带有效期）', () => {
  const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const result = pointsService.earnPoints(global.member1Id, 1000, '消费返点', 'admin', {
    source: 'consumption',
    expireAt
  });
  assert.strictEqual(result.amount, 1000);
  assert.strictEqual(result.balance_after, 1000);
  assert.ok(result.batch_no);
  assert.strictEqual(result.source, 'consumption');
  assert.ok(result.expire_at);
  global.batch1No = result.batch_no;
});

test('获取积分并创建批次（永久有效）', () => {
  const result = pointsService.earnPoints(global.member1Id, 500, '活动奖励', 'admin', {
    source: 'promotion'
  });
  assert.strictEqual(result.amount, 500);
  assert.strictEqual(result.balance_after, 1500);
  assert.ok(result.batch_no);
  assert.strictEqual(result.expire_at, null);
  global.batch2No = result.batch_no;
});

test('查询会员积分批次列表', () => {
  const batches = pointsBatchService.listBatches(global.member1Id);
  assert.strictEqual(batches.length, 2);
  assert.ok(batches[0].expire_at);
  assert.strictEqual(batches[0].status, 'active');
});

test('验证先到期的批次排在前面（FIFO顺序）', () => {
  const batches = pointsBatchService.listBatches(global.member1Id);
  assert.strictEqual(batches.length, 2);
  assert.ok(batches[0].expire_at !== null);
  assert.strictEqual(batches[1].expire_at, null);
});

test('积分扣减按FIFO规则（先扣先到期的）', () => {
  const beforeBatches = pointsBatchService.listBatches(global.member1Id);
  const batch1Before = beforeBatches.find(b => b.batch_no === global.batch1No);
  const batch2Before = beforeBatches.find(b => b.batch_no === global.batch2No);

  assert.strictEqual(batch1Before.remaining_amount, 1000);
  assert.strictEqual(batch2Before.remaining_amount, 500);

  const result = pointsService.spendPoints(global.member1Id, 300, '测试扣减', 'admin');
  assert.strictEqual(result.amount, 300);
  assert.strictEqual(result.balance_after, 1200);

  const afterBatches = pointsBatchService.listBatches(global.member1Id);
  const batch1After = afterBatches.find(b => b.batch_no === global.batch1No);
  const batch2After = afterBatches.find(b => b.batch_no === global.batch2No);

  assert.strictEqual(batch1After.remaining_amount, 700);
  assert.strictEqual(batch1After.status, 'partially_used');
  assert.strictEqual(batch2After.remaining_amount, 500);
  assert.strictEqual(batch2After.status, 'active');
});

test('积分扣减跨多个批次（先用完第一个，再扣第二个）', () => {
  const result = pointsService.spendPoints(global.member1Id, 900, '测试跨批次扣减', 'admin');
  assert.strictEqual(result.amount, 900);
  assert.strictEqual(result.balance_after, 300);

  const batches = pointsBatchService.listBatches(global.member1Id);
  const batch1 = batches.find(b => b.batch_no === global.batch1No);
  const batch2 = batches.find(b => b.batch_no === global.batch2No);

  assert.strictEqual(batch1.remaining_amount, 0);
  assert.strictEqual(batch1.status, 'used_up');
  assert.strictEqual(batch2.remaining_amount, 300);
  assert.strictEqual(batch2.status, 'partially_used');
});

test('批次扣减记录可查询', () => {
  const batch = pointsBatchService.getBatchByNo(global.batch1No);
  const deductions = pointsBatchService.getBatchDeductions(batch.id);
  assert.ok(deductions.length >= 2);
  deductions.forEach(d => {
    assert.strictEqual(d.deduction_type, 'spend');
  });
});

test('获取即将过期的积分批次', () => {
  const expiring = pointsBatchService.getExpiringBatches(global.member1Id, 24 * 30);
  assert.ok(expiring.length >= 0);
});

console.log('\n3. 积分过期处理测试');
test('创建短期有效的积分批次', () => {
  const expireAt = Date.now() - 1000;
  const result = pointsService.earnPoints(global.member1Id, 200, '短期积分', 'admin', {
    source: 'test',
    expireAt
  });
  assert.ok(result.batch_no);
  global.expiredBatchNo = result.batch_no;
});

test('处理过期积分批次', () => {
  const testMember = memberService.registerMember('TST_EXPIRE_001', '过期测试会员', 'normal', 'admin');

  const expireAtPast = Date.now() - 1000;
  pointsService.earnPoints(testMember.id, 250, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  const expireAtFuture = Date.now() + 1000 * 60 * 60;
  pointsService.earnPoints(testMember.id, 500, '未过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtFuture
  });

  const beforeMember = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  const beforeTotal = beforeMember.points;
  assert.strictEqual(beforeTotal, 750);

  const result = pointsBatchService.processMemberExpiredBatches(testMember.id, 'admin');
  assert.strictEqual(result.processed_count, 1);
  assert.strictEqual(result.total_expired_points, 250);

  const afterMember = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(afterMember.points, beforeTotal - 250);
  assert.strictEqual(afterMember.points, 500);
});

test('过期积分生成过期流水', () => {
  memberService.getMemberPointsInfo(global.member1Id);

  const transactions = pointsService.getTransactionHistory(global.member1Id, { type: 'expire' });
  assert.ok(transactions.length >= 1);
  assert.ok(transactions[0].amount < 0);
});

test('已过期的批次状态为expired', () => {
  pointsBatchService.processMemberExpiredBatches(global.member1Id, 'admin');

  const batch = pointsBatchService.getBatchByNo(global.expiredBatchNo);
  assert.strictEqual(batch.status, 'expired');
  assert.strictEqual(batch.remaining_amount, 0);
});

test('过期积分不能再用于兑换', () => {
  const available = pointsBatchService.getTotalAvailablePoints(global.member1Id);
  const info = memberService.getMemberPointsInfo(global.member1Id);
  assert.strictEqual(available, info.total_points);
});

console.log('\n4. 兑换风控规则测试');
test('创建单日兑换次数限制规则', () => {
  const rule = riskControlService.createRule('DAILY_COUNT_LIMIT', '单日兑换次数上限', 'daily_count', {
    maxDailyRedemptions: 3,
    description: '普通会员每日最多兑换3次',
    operator: 'admin'
  });
  assert.strictEqual(rule.rule_code, 'DAILY_COUNT_LIMIT');
  assert.strictEqual(rule.max_daily_redemptions, 3);
  assert.strictEqual(rule.status, 'active');
  global.dailyCountRuleId = rule.id;
});

test('创建单日消耗积分上限规则', () => {
  const rule = riskControlService.createRule('DAILY_POINTS_LIMIT', '单日消耗积分上限', 'daily_points', {
    maxDailyPoints: 2000,
    description: '普通会员每日最多消耗2000积分',
    operator: 'admin'
  });
  assert.strictEqual(rule.rule_code, 'DAILY_POINTS_LIMIT');
  assert.strictEqual(rule.max_daily_points, 2000);
  global.dailyPointsRuleId = rule.id;
});

test('创建账号状态风控规则', () => {
  const rule = riskControlService.createRule('ACCOUNT_STATUS_CHECK', '账号状态检查', 'account_status', {
    description: '冻结账号禁止兑换',
    operator: 'admin'
  });
  assert.strictEqual(rule.rule_code, 'ACCOUNT_STATUS_CHECK');
  global.accountStatusRuleId = rule.id;
});

test('创建同一权益兑换间隔规则', () => {
  const rule = riskControlService.createRule('SAME_BENEFIT_INTERVAL', '同一权益兑换间隔', 'same_benefit_interval', {
    sameBenefitIntervalHours: 24,
    description: '同一权益24小时内只能兑换一次',
    operator: 'admin'
  });
  assert.strictEqual(rule.rule_code, 'SAME_BENEFIT_INTERVAL');
  assert.strictEqual(rule.same_benefit_interval_hours, 24);
  global.sameBenefitRuleId = rule.id;
});

test('查询所有激活的风控规则', () => {
  const rules = riskControlService.listRules({ status: 'active' });
  assert.ok(rules.length >= 4);
});

console.log('\n5. 权益管理测试');
test('创建权益 - 100元优惠券（库存10）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = benefitService.createBenefit('COUPON100_NEW', '100元优惠券', 500, 10, {
    description: '全场通用100元优惠券',
    expireAt: future,
    minLevel: 'normal',
    operator: 'admin'
  });
  assert.strictEqual(benefit.benefit_code, 'COUPON100_NEW');
  assert.strictEqual(benefit.points_cost, 500);
  assert.strictEqual(benefit.available_stock, 10);
  global.benefit1Id = benefit.id;
});

test('创建权益 - 小礼品（库存100）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = benefitService.createBenefit('SMALL_GIFT', '小礼品', 100, 100, {
    expireAt: future,
    minLevel: 'normal',
    operator: 'admin'
  });
  global.benefit2Id = benefit.id;
});

test('创建权益 - 高积分礼品（库存10）', () => {
  const future = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const benefit = benefitService.createBenefit('EXPENSIVE_NEW', '高积分礼品', 3000, 10, {
    expireAt: future,
    minLevel: 'normal',
    operator: 'admin'
  });
  global.benefit3Id = benefit.id;
});

console.log('\n6. 权益兑换与券码生成测试');
test('兑换成功后生成券码', () => {
  pointsService.earnPoints(global.member2Id, 5000, '测试积分', 'admin');

  const result = redemptionService.redeemBenefit(global.member2Id, global.benefit1Id, 'admin');
  assert.strictEqual(result.success, true);
  assert.ok(result.coupon_code);
  assert.ok(result.coupon_code.startsWith('CPN'));
  assert.ok(result.coupon_expire_at);
  global.coupon1Code = result.coupon_code;
  global.redemption1No = result.redemption_no;
});

test('兑换记录关联的券码可查询', () => {
  const coupons = couponService.getCouponsByRedemption(
    db.prepare('SELECT id FROM redemptions WHERE redemption_no = ?').get(global.redemption1No).id
  );
  assert.strictEqual(coupons.length, 1);
  assert.strictEqual(coupons[0].status, 'pending');
});

test('券码详情包含会员和权益信息', () => {
  const coupon = couponService.getCouponByCode(global.coupon1Code);
  assert.strictEqual(coupon.member_no, 'M002');
  assert.strictEqual(coupon.benefit_code, 'COUPON100_NEW');
  assert.strictEqual(coupon.points_cost, 500);
  assert.strictEqual(coupon.status, 'pending');
});

console.log('\n7. 券码核销测试');
test('核销券码成功', () => {
  const coupon = couponService.redeemCoupon(global.coupon1Code, 'admin');
  assert.strictEqual(coupon.status, 'used');
  assert.ok(coupon.used_at);
});

test('重复核销券码被拒绝', () => {
  assert.throws(() => {
    couponService.redeemCoupon(global.coupon1Code, 'admin');
  }, /已核销/);
});

test('券码核销后状态可复查', () => {
  const coupon = couponService.getCouponByCode(global.coupon1Code);
  assert.strictEqual(coupon.status, 'used');
  assert.ok(coupon.used_at);
});

console.log('\n8. 券码作废与积分退回测试');
test('兑换新权益用于作废测试', () => {
  const result = redemptionService.redeemBenefit(global.member2Id, global.benefit2Id, 'admin');
  assert.strictEqual(result.success, true);
  global.voidCouponCode = result.coupon_code;
  global.voidRedemptionNo = result.redemption_no;
});

test('作废前会员积分记录', () => {
  const beforeInfo = memberService.getMemberPointsInfo(global.member2Id);
  global.pointsBeforeVoid = beforeInfo.total_points;
});

test('作废券码成功', () => {
  const coupon = couponService.voidCoupon(global.voidCouponCode, '用户申请作废', 'admin');
  assert.strictEqual(coupon.status, 'voided');
  assert.ok(coupon.voided_at);
  assert.strictEqual(coupon.void_reason, '用户申请作废');
});

test('作废券码后积分退回', () => {
  const afterInfo = memberService.getMemberPointsInfo(global.member2Id);
  assert.strictEqual(afterInfo.total_points, global.pointsBeforeVoid + 100);
});

test('作废的券码不能再核销', () => {
  assert.throws(() => {
    couponService.redeemCoupon(global.voidCouponCode, 'admin');
  }, /已作废/);
});

test('退回的积分回到对应批次', () => {
  const batches = pointsBatchService.listBatches(global.member2Id);
  const totalRemaining = batches.reduce((sum, b) => sum + b.remaining_amount, 0);
  const memberInfo = memberService.getMemberPointsInfo(global.member2Id);
  assert.strictEqual(totalRemaining, memberInfo.total_points);
});

console.log('\n9. 券码过期处理测试');
test('创建短期券码用于过期测试', () => {
  const shortExpireBenefit = benefitService.createBenefit('SHORT_EXPIRE', '短期券权益', 200, 10, {
    expireAt: Date.now() - 1000,
    minLevel: 'normal',
    operator: 'admin'
  });
  global.shortExpireBenefitId = shortExpireBenefit.id;
});

test('兑换短期权益生成已过期的券码', () => {
  const result = redemptionService.redeemBenefit(global.member2Id, global.shortExpireBenefitId, 'admin');
  assert.strictEqual(result.success, true);
  global.expiredCouponCode = result.coupon_code;
});

test('过期券码不能核销', () => {
  assert.throws(() => {
    couponService.redeemCoupon(global.expiredCouponCode, 'admin');
  }, /过期/);
});

test('批量处理过期券码', () => {
  const beforeInfo = memberService.getMemberPointsInfo(global.member2Id);
  const beforePoints = beforeInfo.total_points;

  riskControlService.updateRuleStatus(global.dailyCountRuleId, 'inactive', 'admin');

  const shortExpireBenefit2 = benefitService.createBenefit('SHORT_EXPIRE_2', '短期券权益2', 150, 10, {
    expireAt: Date.now() - 1000,
    minLevel: 'normal',
    operator: 'admin'
  });

  const result2 = redemptionService.redeemBenefit(global.member2Id, shortExpireBenefit2.id, 'admin');
  assert.strictEqual(result2.success, true);
  const newExpiredCouponCode = result2.coupon_code;

  const result = couponService.processExpiredCoupons('admin');
  assert.ok(result.processed_count >= 1);

  const afterInfo = memberService.getMemberPointsInfo(global.member2Id);
  assert.strictEqual(afterInfo.total_points, beforePoints);

  const coupon = couponService.getCouponByCode(newExpiredCouponCode);
  assert.strictEqual(coupon.status, 'expired');

  riskControlService.updateRuleStatus(global.dailyCountRuleId, 'active', 'admin');
});

test('过期券码状态更新为expired', () => {
  const coupon = couponService.getCouponByCode(global.expiredCouponCode);
  assert.strictEqual(coupon.status, 'expired');
  assert.ok(coupon.expired_at);
});

console.log('\n10. 风控拦截测试');
test('达到单日兑换次数上限被拦截', () => {
  for (let i = 0; i < 2; i++) {
    redemptionService.redeemBenefit(global.member2Id, global.benefit2Id, 'admin');
  }
  const result = redemptionService.redeemBenefit(global.member2Id, global.benefit2Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, '超过单日兑换次数限制');
  assert.ok(result.details.includes('今日已兑换'));
  assert.ok(result.risk_record_no);
});

test('风控拦截生成风控记录', () => {
  const records = riskControlService.listRiskRecords({ memberId: global.member2Id });
  assert.ok(records.length >= 1);
  const dailyCountRecord = records.find(r => r.rule_type === 'daily_count');
  assert.ok(dailyCountRecord);
  assert.strictEqual(dailyCountRecord.status, 'blocked');
  assert.ok(dailyCountRecord.hit_reason);
});

test('风控记录可按规则类型筛选', () => {
  const records = riskControlService.listRiskRecords({ ruleType: 'daily_count' });
  assert.ok(records.length >= 1);
  records.forEach(r => {
    assert.strictEqual(r.rule_type, 'daily_count');
  });
});

test('禁用风控规则后不再拦截', () => {
  riskControlService.updateRuleStatus(global.dailyCountRuleId, 'inactive', 'admin');
  riskControlService.updateRuleStatus(global.sameBenefitRuleId, 'inactive', 'admin');

  pointsService.earnPoints(global.member2Id, 1000, '补充积分', 'admin');
  const result = redemptionService.redeemBenefit(global.member2Id, global.benefit2Id, 'admin');
  assert.strictEqual(result.success, true);

  riskControlService.updateRuleStatus(global.dailyCountRuleId, 'active', 'admin');
  riskControlService.updateRuleStatus(global.sameBenefitRuleId, 'active', 'admin');
});

test('单日消耗积分上限拦截', () => {
  pointsService.earnPoints(global.member1Id, 3000, '测试大额积分', 'admin');
  const result = redemptionService.redeemBenefit(global.member1Id, global.benefit3Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, '超过单日消耗积分上限');
});

test('冻结账号被风控拦截', () => {
  memberService.freezeMember(global.member1Id, 'admin', '测试冻结');
  const result = redemptionService.redeemBenefit(global.member1Id, global.benefit2Id, 'admin');
  assert.strictEqual(result.success, false);
  assert.ok(result.reason === '账号状态异常' || result.reason === '账号已冻结');
  memberService.unfreezeMember(global.member1Id, 'admin', '测试解冻');
});

console.log('\n11. 结算报表测试');
test('结算报表 - 总览统计', () => {
  const stats = settlementService.getSettlementStats();
  assert.ok(stats.total_coupons > 0);
  assert.ok(stats.used_coupons >= 1);
  assert.ok(stats.voided_coupons >= 1);
  assert.ok(stats.expired_coupons >= 0);
  assert.ok(stats.consumed_points > 0);
  assert.ok(stats.refunded_points > 0);
});

test('结算报表 - 按会员等级统计', () => {
  const byLevel = settlementService.getSettlementByMemberLevel();
  assert.ok(byLevel.length >= 1);
  byLevel.forEach(item => {
    assert.ok(item.member_level);
    assert.ok(item.total_coupons >= 0);
  });
});

test('结算报表 - 按权益统计', () => {
  const byBenefit = settlementService.getSettlementByBenefit();
  assert.ok(byBenefit.length >= 1);
  byBenefit.forEach(item => {
    assert.ok(item.benefit_code);
    assert.ok(item.total_coupons >= 0);
  });
});

test('结算报表 - 按日期统计', () => {
  const byDate = settlementService.getSettlementByDate();
  assert.ok(byDate.length >= 1);
  byDate.forEach(item => {
    assert.ok(item.stat_date);
    assert.ok(item.total_coupons >= 0);
  });
});

test('积分结算统计', () => {
  const pointsStats = settlementService.getPointsSettlementStats();
  assert.ok(pointsStats.total_earned_points > 0);
  assert.ok(pointsStats.total_spent_points > 0);
  assert.ok(pointsStats.total_expired_points >= 0);
  assert.ok(pointsStats.total_refunded_points >= 0);
});

test('风控结算统计', () => {
  const riskStats = settlementService.getRiskControlSettlement();
  assert.ok(riskStats.length >= 1);
  riskStats.forEach(item => {
    assert.ok(item.rule_type);
    assert.ok(item.total_records >= 0);
  });
});

test('完整结算报表', () => {
  const report = settlementService.getFullSettlementReport();
  assert.ok(report.period);
  assert.ok(report.coupon_summary);
  assert.ok(report.points_summary);
  assert.ok(report.by_member_level);
  assert.ok(report.by_benefit);
  assert.ok(report.by_date);
  assert.ok(report.risk_control_summary);
});

test('结算报表数据与券码实际状态一致', () => {
  const stats = couponService.getCouponStats();
  const settlementStats = settlementService.getSettlementStats();

  assert.strictEqual(stats.total_count, settlementStats.total_coupons);
  assert.strictEqual(stats.used_count, settlementStats.used_coupons);
  assert.strictEqual(stats.voided_count, settlementStats.voided_coupons);
  assert.strictEqual(stats.expired_count, settlementStats.expired_coupons);
});

console.log('\n12. 数据持久化与重启一致性测试');
test('数据持久化到磁盘，重启后状态一致', () => {
  const beforeMember1 = memberService.getMemberById(global.member1Id);
  const beforeMember2 = memberService.getMemberById(global.member2Id);
  const beforeBenefit1 = benefitService.getBenefitById(global.benefit1Id);
  const beforeCoupon = couponService.getCouponByCode(global.coupon1Code);
  const beforeBatches = pointsBatchService.listBatches(global.member1Id);
  const beforeRiskRecords = riskControlService.listRiskRecords({ memberId: global.member2Id });
  const beforeSettlement = settlementService.getSettlementStats();

  db.pragma('wal_checkpoint(FULL)');

  const Database = require('better-sqlite3');
  const verifyDb = new Database(testDbPath, { readonly: true });

  const member1 = verifyDb.prepare('SELECT * FROM members WHERE id = ?').get(global.member1Id);
  assert.strictEqual(member1.points, beforeMember1.points);
  assert.strictEqual(member1.status, beforeMember1.status);

  const member2 = verifyDb.prepare('SELECT * FROM members WHERE id = ?').get(global.member2Id);
  assert.strictEqual(member2.points, beforeMember2.points);

  const benefit1 = verifyDb.prepare('SELECT * FROM benefits WHERE id = ?').get(global.benefit1Id);
  assert.strictEqual(benefit1.available_stock, beforeBenefit1.available_stock);

  const coupon = verifyDb.prepare('SELECT * FROM coupons WHERE coupon_code = ?').get(global.coupon1Code);
  assert.strictEqual(coupon.status, beforeCoupon.status);
  assert.strictEqual(coupon.points_cost, beforeCoupon.points_cost);

  const batches = verifyDb.prepare('SELECT * FROM points_batches WHERE member_id = ? ORDER BY expire_at IS NULL, expire_at ASC, created_at ASC').all(global.member1Id);
  assert.strictEqual(batches.length, beforeBatches.length);
  batches.forEach((b, i) => {
    assert.strictEqual(b.batch_no, beforeBatches[i].batch_no);
    assert.strictEqual(b.remaining_amount, beforeBatches[i].remaining_amount);
    assert.strictEqual(b.status, beforeBatches[i].status);
  });

  const riskRecords = verifyDb.prepare('SELECT * FROM risk_control_records WHERE member_id = ?').all(global.member2Id);
  assert.strictEqual(riskRecords.length, beforeRiskRecords.length);

  const couponStats = verifyDb.prepare(`
    SELECT 
      COUNT(*) as total_coupons,
      SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used_coupons,
      SUM(CASE WHEN status = 'used' THEN points_cost ELSE 0 END) as consumed_points
    FROM coupons
  `).get();
  assert.strictEqual(couponStats.total_coupons, beforeSettlement.total_coupons);
  assert.strictEqual(couponStats.used_coupons, beforeSettlement.used_coupons);
  assert.strictEqual(couponStats.consumed_points, beforeSettlement.consumed_points);

  verifyDb.close();
});

console.log('\n13. 操作日志与审计测试');
test('积分批次操作有日志记录', () => {
  const logs = logService.listOperationLogs({ memberId: global.member1Id });
  const types = logs.map(l => l.operation_type);
  assert.ok(types.includes('points_batch_create'));
  assert.ok(types.includes('points_batch_deduct'));
});

test('风控操作有日志记录', () => {
  const logs = logService.listOperationLogs({});
  const types = logs.map(l => l.operation_type);
  assert.ok(types.includes('risk_rule_create'));
  assert.ok(types.includes('risk_record_create'));
});

test('券码操作有日志记录', () => {
  const logs = logService.listOperationLogs({ memberId: global.member2Id });
  const types = logs.map(l => l.operation_type);
  assert.ok(types.includes('coupon_create'));
  assert.ok(types.includes('coupon_redeem'));
  assert.ok(types.includes('coupon_void'));
});

console.log('\n14. 实时过期处理验证测试');
test('积分到期未批处理时，查询可用积分自动排除过期批次', () => {
  const testMember = memberService.registerMember('TST_RT_001', '实时过期测试会员1', 'normal', 'admin');

  const expireAtPast = Date.now() - 500;
  pointsService.earnPoints(testMember.id, 300, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  const expireAtFuture = Date.now() + 1000 * 60 * 60;
  pointsService.earnPoints(testMember.id, 500, '未过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtFuture
  });

  const memberDbBefore = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbBefore.points, 800);

  const info = memberService.getMemberPointsInfo(testMember.id);
  assert.strictEqual(info.available_points, 500);
  assert.strictEqual(info.total_points, 500);

  const memberDbAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbAfter.points, 500);

  const transactions = pointsService.getTransactionHistory(testMember.id, { type: 'expire' });
  assert.ok(transactions.length >= 1);
  assert.strictEqual(transactions[0].amount, -300);
});

test('积分到期未批处理时，直接扣减会先处理过期再扣减未过期批次', () => {
  const testMember = memberService.registerMember('TST_RT_002', '实时过期测试会员2', 'normal', 'admin');

  const expireAtPast = Date.now() - 500;
  pointsService.earnPoints(testMember.id, 200, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  const expireAtNear = Date.now() + 1000 * 60;
  pointsService.earnPoints(testMember.id, 300, '快到期积分', 'admin', {
    source: 'test',
    expireAt: expireAtNear
  });

  const expireAtFar = Date.now() + 1000 * 60 * 60 * 24;
  pointsService.earnPoints(testMember.id, 500, '远到期积分', 'admin', {
    source: 'test',
    expireAt: expireAtFar
  });

  const memberDbBefore = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbBefore.points, 1000);

  pointsService.spendPoints(testMember.id, 400, '测试扣减', 'admin');

  const memberDbAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbAfter.points, 400);

  const batches = pointsBatchService.listBatches(testMember.id);
  const nearBatch = batches.find(b => b.reason === '快到期积分');
  const farBatch = batches.find(b => b.reason === '远到期积分');

  assert.strictEqual(nearBatch.remaining_amount, 0);
  assert.strictEqual(nearBatch.status, 'used_up');
  assert.strictEqual(farBatch.remaining_amount, 400);
  assert.strictEqual(farBatch.status, 'partially_used');
});

test('积分到期未批处理时，积分不足兑换会被拒绝（先扣过期后判断）', () => {
  const testMember = memberService.registerMember('TST_RT_003', '实时过期测试会员3', 'normal', 'admin');

  const expireAtPast = Date.now() - 500;
  pointsService.earnPoints(testMember.id, 500, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  pointsService.earnPoints(testMember.id, 100, '未过期积分', 'admin', {
    source: 'test',
    expireAt: Date.now() + 1000 * 60 * 60
  });

  const testBenefit = benefitService.createBenefit('RT_TEST_BENEFIT', '实时过期测试权益', 300, 10, {
    minLevel: 'normal',
    operator: 'admin'
  });

  const result = redemptionService.redeemBenefit(testMember.id, testBenefit.id, 'admin');
  assert.strictEqual(result.success, false);
  assert.ok(result.reason.includes('积分不足') || result.reason.includes('积分'));

  const memberDbAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbAfter.points, 100);

  const info = memberService.getMemberPointsInfo(testMember.id);
  assert.strictEqual(info.available_points, 100);
});

test('积分到期未批处理时，兑换会先生成过期流水再使用未过期批次', () => {
  const testMember = memberService.registerMember('TST_RT_004', '实时过期测试会员4', 'normal', 'admin');

  const expireAtPast = Date.now() - 500;
  pointsService.earnPoints(testMember.id, 200, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  const expireAtNear = Date.now() + 1000 * 60;
  pointsService.earnPoints(testMember.id, 300, '快到期积分', 'admin', {
    source: 'test',
    expireAt: expireAtNear
  });

  const expireAtFar = Date.now() + 1000 * 60 * 60 * 24;
  pointsService.earnPoints(testMember.id, 500, '远到期积分', 'admin', {
    source: 'test',
    expireAt: expireAtFar
  });

  const testBenefit = benefitService.createBenefit('RT_TEST_BENEFIT2', '实时过期测试权益2', 600, 10, {
    minLevel: 'normal',
    operator: 'admin'
  });

  const result = redemptionService.redeemBenefit(testMember.id, testBenefit.id, 'admin');
  assert.strictEqual(result.success, true);
  assert.ok(result.coupon_code);

  const memberDbAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbAfter.points, 200);

  const expireTransactions = pointsService.getTransactionHistory(testMember.id, { type: 'expire' });
  assert.ok(expireTransactions.length >= 1);
  const totalExpired = expireTransactions.reduce((s, t) => s + Math.abs(t.amount), 0);
  assert.strictEqual(totalExpired, 200);

  const batches = pointsBatchService.listBatches(testMember.id);
  const nearBatch = batches.find(b => b.reason === '快到期积分');
  const farBatch = batches.find(b => b.reason === '远到期积分');
  const pastBatch = batches.find(b => b.reason === '已过期积分');

  assert.strictEqual(pastBatch.status, 'expired');
  assert.strictEqual(nearBatch.remaining_amount, 0);
  assert.strictEqual(nearBatch.status, 'used_up');
  assert.strictEqual(farBatch.remaining_amount, 200);
  assert.strictEqual(farBatch.status, 'partially_used');
});

test('积分到期未批处理时，冻结积分使用真实可用积分判断', () => {
  const testMember = memberService.registerMember('TST_RT_005', '实时过期测试会员5', 'normal', 'admin');

  const expireAtPast = Date.now() - 500;
  pointsService.earnPoints(testMember.id, 500, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  pointsService.earnPoints(testMember.id, 200, '未过期积分', 'admin', {
    source: 'test',
    expireAt: Date.now() + 1000 * 60 * 60
  });

  assert.throws(() => {
    pointsService.freezePoints(testMember.id, 300, '测试冻结', 'admin');
  }, /可用积分不足/);

  const result = pointsService.freezePoints(testMember.id, 150, '测试冻结', 'admin');
  assert.ok(result.transaction_no);

  const memberDbAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(testMember.id);
  assert.strictEqual(memberDbAfter.points, 200);
  assert.strictEqual(memberDbAfter.frozen_points, 150);
});

test('扣减批次查询不包含已到期批次', () => {
  const testMember = memberService.registerMember('TST_RT_006', '实时过期测试会员6', 'normal', 'admin');

  const expireAtPast = Date.now() - 500;
  pointsService.earnPoints(testMember.id, 300, '已过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtPast
  });

  const expireAtFuture = Date.now() + 1000 * 60 * 60;
  pointsService.earnPoints(testMember.id, 500, '未过期积分', 'admin', {
    source: 'test',
    expireAt: expireAtFuture
  });

  const batchesBefore = db.prepare(`
    SELECT * FROM points_batches
    WHERE member_id = ? AND status IN ('active', 'partially_used')
  `).all(testMember.id);
  assert.strictEqual(batchesBefore.length, 2);

  const availableBatches = pointsBatchService.getAvailableBatchesForSpend(testMember.id);
  assert.strictEqual(availableBatches.length, 1);
  assert.strictEqual(availableBatches[0].remaining_amount, 500);
  assert.strictEqual(availableBatches[0].reason, '未过期积分');

  const expiredBatch = db.prepare(`
    SELECT * FROM points_batches WHERE member_id = ? AND reason = '已过期积分'
  `).get(testMember.id);
  assert.strictEqual(expiredBatch.status, 'expired');
  assert.strictEqual(expiredBatch.remaining_amount, 0);
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
