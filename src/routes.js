const express = require('express');
const router = express.Router();

const memberService = require('./modules/memberService');
const pointsService = require('./modules/pointsService');
const benefitService = require('./modules/benefitService');
const redemptionService = require('./modules/redemptionService');
const logService = require('./modules/logService');

const handleAsync = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

router.post('/members', handleAsync((req, res) => {
  const { member_no, name, level, operator } = req.body;
  return memberService.registerMember(member_no, name, level, operator);
}));

router.get('/members', handleAsync((req, res) => {
  const { level, status, offset, limit } = req.query;
  return memberService.listMembers({
    level,
    status,
    offset: offset ? parseInt(offset) : 0,
    limit: limit ? parseInt(limit) : 100
  });
}));

router.get('/members/:id', handleAsync((req, res) => {
  return memberService.getMemberById(parseInt(req.params.id));
}));

router.get('/members/no/:memberNo', handleAsync((req, res) => {
  return memberService.getMemberByNo(req.params.memberNo);
}));

router.put('/members/:id/level', handleAsync((req, res) => {
  const { level, operator } = req.body;
  return memberService.updateMemberLevel(parseInt(req.params.id), level, operator);
}));

router.post('/members/:id/freeze', handleAsync((req, res) => {
  const { operator, reason } = req.body;
  return memberService.freezeMember(parseInt(req.params.id), operator, reason);
}));

router.post('/members/:id/unfreeze', handleAsync((req, res) => {
  const { operator, reason } = req.body;
  return memberService.unfreezeMember(parseInt(req.params.id), operator, reason);
}));

router.get('/members/:id/points', handleAsync((req, res) => {
  return memberService.getMemberPointsInfo(parseInt(req.params.id));
}));

router.get('/members/:id/transactions', handleAsync((req, res) => {
  const { type, start_time, end_time, offset, limit } = req.query;
  return pointsService.getTransactionHistory(parseInt(req.params.id), {
    type,
    startTime: start_time ? parseInt(start_time) : null,
    endTime: end_time ? parseInt(end_time) : null,
    offset: offset ? parseInt(offset) : 0,
    limit: limit ? parseInt(limit) : 100
  });
}));

router.get('/members/:id/frozen-records', handleAsync((req, res) => {
  const { status, offset, limit } = req.query;
  return pointsService.getFrozenRecords(parseInt(req.params.id), {
    status,
    offset: offset ? parseInt(offset) : 0,
    limit: limit ? parseInt(limit) : 100
  });
}));

router.post('/points/earn', handleAsync((req, res) => {
  const { member_id, amount, reason, operator } = req.body;
  return pointsService.earnPoints(member_id, amount, reason, operator);
}));

router.post('/points/spend', handleAsync((req, res) => {
  const { member_id, amount, reason, operator } = req.body;
  return pointsService.spendPoints(member_id, amount, reason, operator);
}));

router.post('/points/freeze', handleAsync((req, res) => {
  const { member_id, amount, reason, operator, expire_at } = req.body;
  return pointsService.freezePoints(member_id, amount, reason, operator, expire_at);
}));

router.post('/points/unfreeze', handleAsync((req, res) => {
  const { member_id, frozen_record_id, operator, reason } = req.body;
  return pointsService.unfreezePoints(member_id, frozen_record_id, operator, reason);
}));

router.get('/points/expiring-frozen', handleAsync((req, res) => {
  const { hours } = req.query;
  return pointsService.getExpiringFrozenRecords(hours ? parseInt(hours) : 24);
}));

router.post('/benefits', handleAsync((req, res) => {
  const { benefit_code, name, points_cost, total_stock, description, expire_at, min_level, operator } = req.body;
  return benefitService.createBenefit(benefit_code, name, points_cost, total_stock, {
    description,
    expireAt: expire_at,
    minLevel: min_level,
    operator
  });
}));

router.get('/benefits', handleAsync((req, res) => {
  const { status, min_level, offset, limit } = req.query;
  return benefitService.listBenefits({
    status,
    minLevel: min_level,
    offset: offset ? parseInt(offset) : 0,
    limit: limit ? parseInt(limit) : 100
  });
}));

router.get('/benefits/:id', handleAsync((req, res) => {
  return benefitService.getBenefitById(parseInt(req.params.id));
}));

router.get('/benefits/code/:benefitCode', handleAsync((req, res) => {
  return benefitService.getBenefitByCode(req.params.benefitCode);
}));

router.put('/benefits/:id/stock', handleAsync((req, res) => {
  const { stock_change, operator, reason } = req.body;
  return benefitService.updateBenefitStock(parseInt(req.params.id), stock_change, operator, reason);
}));

router.put('/benefits/:id/status', handleAsync((req, res) => {
  const { status, operator } = req.body;
  return benefitService.updateBenefitStatus(parseInt(req.params.id), status, operator);
}));

router.get('/benefits/expiring-soon', handleAsync((req, res) => {
  const { days } = req.query;
  return benefitService.getExpiringBenefits(days ? parseInt(days) : 7);
}));

router.post('/redemptions', handleAsync((req, res) => {
  const { member_id, benefit_id, operator } = req.body;
  return redemptionService.redeemBenefit(member_id, benefit_id, operator);
}));

router.get('/redemptions', handleAsync((req, res) => {
  const { member_id, benefit_id, status, start_time, end_time, offset, limit } = req.query;
  return redemptionService.listRedemptions({
    memberId: member_id ? parseInt(member_id) : null,
    benefitId: benefit_id ? parseInt(benefit_id) : null,
    status,
    startTime: start_time ? parseInt(start_time) : null,
    endTime: end_time ? parseInt(end_time) : null,
    offset: offset ? parseInt(offset) : 0,
    limit: limit ? parseInt(limit) : 100
  });
}));

router.get('/redemptions/:id', handleAsync((req, res) => {
  return redemptionService.getRedemptionById(parseInt(req.params.id));
}));

router.get('/redemptions/no/:redemptionNo', handleAsync((req, res) => {
  return redemptionService.getRedemptionByNo(req.params.redemptionNo);
}));

router.get('/redemptions/stats/summary', handleAsync((req, res) => {
  const { benefit_id, start_time, end_time } = req.query;
  return redemptionService.getRedemptionStats(
    benefit_id ? parseInt(benefit_id) : null,
    start_time ? parseInt(start_time) : null,
    end_time ? parseInt(end_time) : null
  );
}));

router.get('/logs', handleAsync((req, res) => {
  const {
    operation_type,
    operator,
    member_id,
    member_level,
    benefit_id,
    start_time,
    end_time,
    offset,
    limit
  } = req.query;
  return logService.listOperationLogs({
    operationType: operation_type,
    operator,
    memberId: member_id ? parseInt(member_id) : null,
    memberLevel: member_level,
    benefitId: benefit_id ? parseInt(benefit_id) : null,
    startTime: start_time ? parseInt(start_time) : null,
    endTime: end_time ? parseInt(end_time) : null,
    offset: offset ? parseInt(offset) : 0,
    limit: limit ? parseInt(limit) : 100
  });
}));

router.get('/logs/types', handleAsync((req, res) => {
  return logService.getOperationTypes();
}));

router.get('/logs/stats', handleAsync((req, res) => {
  const { operation_type, member_level, start_time, end_time } = req.query;
  return logService.getLogStats({
    operationType: operation_type,
    memberLevel: member_level,
    startTime: start_time ? parseInt(start_time) : null,
    endTime: end_time ? parseInt(end_time) : null
  });
}));

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: Date.now() } });
});

module.exports = router;
