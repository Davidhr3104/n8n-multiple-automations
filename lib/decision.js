// Determinístico: la decisión final NUNCA la toma la IA. Solo aplica umbrales explícitos.
function decide(ruleResult, aiResult, lead, cfg) {
  const reasons = [];
  let final_score;
  let ai_error = null;

  if (aiResult && aiResult.ok) {
    const a = aiResult.assessment;
    final_score = Math.round(0.4 * ruleResult.rule_score + 0.6 * a.fit_score);
    if (a.confidence < cfg.confidenceThreshold) reasons.push('low_confidence');
    if (a.risk_flags.length > 0) reasons.push('risk_flags');
  } else {
    final_score = ruleResult.rule_score;
    ai_error = (aiResult && aiResult.error) || 'AI result missing';
    reasons.push('ai_failed');
  }

  const tier = final_score >= cfg.hotScore ? 'hot' : final_score >= cfg.warmScore ? 'warm' : 'cold';
  if (tier === 'hot' && (lead.budget_usd || 0) >= cfg.highValueBudget) reasons.push('high_value_requires_signoff');

  return { final_score, tier, needs_human: reasons.length > 0, reasons, ai_error };
}

// Falla cerrado: solo approved === true cuenta como aprobación.
function applyHumanDecision(waitOutput) {
  const approved = waitOutput && waitOutput.data ? waitOutput.data.approved : waitOutput && waitOutput.approved;
  if (approved === true) return { status: 'approved_by_human' };
  if (approved === false) return { status: 'rejected_by_human' };
  return { status: 'no_human_response' };
}

module.exports = { decide, applyHumanDecision };
