// Cheap rule-based scoring of a new posting from its title and location (0–100).
// Polls read only titles and locations, so experience years are left to Claude (get_job) in the digest.
// Edit the lists below to tune what counts as a match.

const RULES = {
  // Seniority and roles outside the target: score 0.
  drop: /\b(senior|sr\.?|lead|staff|principal|manager|director|head|vp|vice president|chief|architect|distinguished|fellow|intern|internship|trainee|apprentice)\b/i,
  // Titles worth a look.
  role: /\b(sde|software|developer|engineer|engineering|programmer|backend|back-end|full[ -]?stack|platform|ai|ml|machine learning|genai|llm|agent|agents|applied|forward[ -]deployed|python)\b|\.net\b|\bc#/i,
  // …but not these engineering flavours.
  offTarget: /\b(sales|solutions? engineer|support|customer|hardware|mechanical|electrical|civil|chemical|asic|analog|rtl|vlsi|physical design|silicon|firmware|embedded|network engineer|field|manufacturing|process|validation|test engineer|design verification)\b/i,
  strongRole: /\b(backend|back-end|full[ -]?stack|ai|ml|genai|llm|agent|agents|applied ai|forward[ -]deployed|platform)\b/i,
  junior: /\b(sde[ -]?(1|i)|software engineer[ -]?(1|i)|engineer[ -]?(1|i)|junior|jr\.?|associate|new grad|graduate|entry|early career|2025|2026)\b/i,
  stack: [/\.net\b/i, /\bc#/i, /\bpython\b/i, /\bfastapi\b/i, /\btypescript\b/i, /\bazure\b/i, /\bllm/i, /\brag\b/i, /\bmcp\b/i, /\bagent/i, /\bgen ?ai\b/i],
  penalty: [
    { re: /\bjava\b(?!script)/i, points: 15 },
    { re: /\b(front[ -]?end|ui engineer|ui developer|react developer|ios|android|mobile)\b/i, points: 15 },
    { re: /\b(qa|quality|sdet|test|testing|automation tester)\b/i, points: 25 },
    { re: /\b(data analyst|business analyst|analyst)\b/i, points: 25 },
  ],
  ncr: /\b(gurugram|gurgaon|noida|delhi|new delhi|ncr|faridabad|ghaziabad)\b/i,
  bangalore: /\b(bengaluru|bangalore)\b/i,
  india: /\b(india|indian|hyderabad|pune|mumbai|chennai|kolkata|ahmedabad|jaipur|kochi|coimbatore|chandigarh|indore|trivandrum|thiruvananthapuram|mohali|vadodara|nagpur|bhubaneswar|mysore|mysuru)\b/i,
  indiaCode: /(^|, )IN\b/, // SmartRecruiters writes the country as a code
  // A location that names another country/region (used to drop remote roles tied elsewhere).
  elsewhere: /\b(us|usa|united states|canada|uk|united kingdom|europe|emea|germany|france|spain|netherlands|ireland|poland|singapore|australia|japan|brazil|mexico|latam|apac|americas|philippines|vietnam|indonesia|israel|uae|dubai)\b/i,
};

export interface Score {
  score: number;
  reject?: string;
}

export function scoreJob(title: string, location: string, remote: boolean): Score {
  const t = title.replace(/\s+/g, " ");
  if (RULES.drop.test(t)) return { score: 0, reject: "seniority" };
  if (!RULES.role.test(t) || RULES.offTarget.test(t)) return { score: 0, reject: "role" };

  // Location: India, or remote without a non-India country attached.
  const loc = location || "";
  const india = RULES.india.test(loc) || RULES.indiaCode.test(loc);
  let where: number;
  if (RULES.ncr.test(loc)) where = 25;
  else if (RULES.bangalore.test(loc)) where = 18;
  else if (remote && india) where = 14;
  else if (india) where = 8;
  else if (remote && !RULES.elsewhere.test(loc)) where = 4;
  else if (!loc.trim()) where = 2;
  else return { score: 0, reject: "location" };

  let score = 50 + where;
  if (RULES.strongRole.test(t)) score += 5;
  if (RULES.junior.test(t)) score += 5;
  score += Math.min(20, RULES.stack.filter((re) => re.test(t)).length * 5);
  for (const p of RULES.penalty) if (p.re.test(t)) score -= p.points;
  return { score: Math.max(1, Math.min(100, score)) };
}

// Same role at the same place within 14 days = a repost, not a new job.
export const dedupeKey = (title: string, location: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9#+.]+/g, " ").trim()}|${location.toLowerCase().replace(/[^a-z]+/g, " ").trim()}`;
