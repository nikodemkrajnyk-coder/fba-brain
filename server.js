require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
const DATA = path.join(DATA_DIR, 'state.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function load() { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA,'utf8')); } catch(e){} return {deals:[],inventory:[],alerts:[],processed:[],budget:200,log:[]}; }
function save(s) { try { fs.writeFileSync(DATA, JSON.stringify(s,null,2)); } catch(e){} }
let S = load();
// Autopilot settings (saved in state)
S.autopilot = S.autopilot || { enabled: false, minScore: 75, minProfit: 5, minChecks: 7, maxSpendPerDeal: 200, dailyBudgetLimit: 200 };
function log(m) { const e=`[${new Date().toLocaleTimeString('en-GB')}] ${m}`; console.log(e); S.log=[e,...(S.log||[])].slice(0,200); }

// ═══════════════════════════════════════
// DEMAND ESTIMATION ENGINE
// BSR → estimated daily/monthly sales
// Based on category benchmarks
// ═══════════════════════════════════════
const BSR_SALES_MAP = {
  // [maxBSR, estimatedDailySales]
  'Home & Kitchen': [[100,80],[500,40],[1000,25],[2000,15],[5000,8],[10000,4],[20000,2],[50000,1],[100000,0.3]],
  'Kitchen': [[100,80],[500,40],[1000,25],[2000,15],[5000,8],[10000,4],[20000,2],[50000,1],[100000,0.3]],
  'Electronics': [[100,60],[500,30],[1000,18],[2000,10],[5000,5],[10000,2.5],[20000,1],[50000,0.5],[100000,0.2]],
  'Pet Supplies': [[100,50],[500,25],[1000,15],[2000,8],[5000,4],[10000,2],[20000,1],[50000,0.5],[100000,0.2]],
  'Sports': [[100,40],[500,20],[1000,12],[2000,7],[5000,3],[10000,1.5],[20000,0.8],[50000,0.3],[100000,0.1]],
  'default': [[100,50],[500,25],[1000,15],[2000,8],[5000,4],[10000,2],[20000,1],[50000,0.5],[100000,0.2]],
};

function estimateSales(bsr, category) {
  if (!bsr || bsr <= 0) return { daily: 0, monthly: 0, confidence: 'none' };
  const catKey = Object.keys(BSR_SALES_MAP).find(k => (category||'').includes(k)) || 'default';
  const map = BSR_SALES_MAP[catKey];
  let daily = 0;
  for (const [maxBsr, sales] of map) {
    if (bsr <= maxBsr) { daily = sales; break; }
  }
  if (daily === 0 && bsr > 100000) daily = 0.1;
  const monthly = Math.round(daily * 30);
  const confidence = bsr <= 5000 ? 'high' : bsr <= 20000 ? 'medium' : 'low';
  return { daily: parseFloat(daily.toFixed(1)), monthly, confidence };
}

// Demand risk assessment
function assessDemand(bsr, reviewCount, rating, salesEstimate) {
  let score = 0;
  let reasons = [];
  let level = 'skip';

  // BSR scoring (0-30 points)
  if (bsr <= 1000) { score += 30; reasons.push('Top 1,000 seller — extremely high demand'); }
  else if (bsr <= 5000) { score += 25; reasons.push('Top 5,000 — high demand'); }
  else if (bsr <= 20000) { score += 18; reasons.push('Top 20,000 — good demand'); }
  else if (bsr <= 50000) { score += 10; reasons.push('Top 50,000 — moderate demand'); }
  else if (bsr <= 100000) { score += 5; reasons.push('Top 100,000 — low demand ⚠️'); }
  else { score += 0; reasons.push('BSR over 100,000 — very low demand ❌'); }

  // Review scoring (0-25 points)
  if (reviewCount >= 10000) { score += 25; reasons.push(`${(reviewCount/1000).toFixed(0)}K+ reviews — massive proven demand`); }
  else if (reviewCount >= 5000) { score += 20; reasons.push(`${(reviewCount/1000).toFixed(0)}K+ reviews — strong demand`); }
  else if (reviewCount >= 1000) { score += 15; reasons.push(`${(reviewCount/1000).toFixed(0)}K+ reviews — proven product`); }
  else if (reviewCount >= 200) { score += 8; reasons.push(`${reviewCount} reviews — moderate proof`); }
  else { score += 0; reasons.push('Under 200 reviews — unproven product ⚠️'); }

  // Rating (0-15 points)
  if (rating >= 4.5) { score += 15; reasons.push(`${rating}★ — excellent rating`); }
  else if (rating >= 4.0) { score += 10; reasons.push(`${rating}★ — good rating`); }
  else if (rating >= 3.5) { score += 5; reasons.push(`${rating}★ — average rating`); }
  else { score += 0; reasons.push(`${rating}★ — poor rating, high return risk ❌`); }

  // Sales estimate (0-30 points)
  if (salesEstimate.monthly >= 500) { score += 30; reasons.push(`~${salesEstimate.monthly} sales/month — your 50 units = tiny fraction`); }
  else if (salesEstimate.monthly >= 200) { score += 25; reasons.push(`~${salesEstimate.monthly} sales/month — strong velocity`); }
  else if (salesEstimate.monthly >= 100) { score += 18; reasons.push(`~${salesEstimate.monthly} sales/month — good velocity`); }
  else if (salesEstimate.monthly >= 30) { score += 10; reasons.push(`~${salesEstimate.monthly} sales/month — moderate`); }
  else { score += 0; reasons.push(`~${salesEstimate.monthly} sales/month — slow, risk of unsold stock ⚠️`); }

  if (score >= 75) level = 'strong_buy';
  else if (score >= 55) level = 'buy';
  else if (score >= 40) level = 'caution';
  else level = 'skip';

  return { score, level, reasons, salesEstimate };
}

// ═══════════════════════════════════════
// PRODUCT QUALITY VERIFICATION ENGINE
// Checks if product is ACTUALLY good
// ═══════════════════════════════════════

// Return rate benchmarks by category (Amazon UK averages)
const RETURN_RATES = {
  'Home & Kitchen': 3.5, 'Kitchen': 3.5, 'Electronics': 6.0, 'Clothing': 20.0,
  'Pet Supplies': 4.0, 'Sports': 5.0, 'Baby': 5.5, 'Beauty': 4.0,
  'Toys': 6.0, 'Garden': 4.5, 'Automotive': 5.0, 'Health': 3.0, 'default': 5.0,
};

// Fake review detection (ReviewMeta-style analysis)
function analyseReviewAuthenticity(reviewCount, rating, bsr) {
  let score = 0;
  let reasons = [];
  let grade = 'F';

  // High review count + consistent rating = likely real
  if (reviewCount >= 10000 && rating >= 4.0 && rating <= 4.8) {
    score = 95; grade = 'A';
    reasons.push(`${(reviewCount/1000).toFixed(0)}K+ reviews with ${rating}★ — pattern consistent with genuine reviews`);
  } else if (reviewCount >= 5000 && rating >= 3.8) {
    score = 85; grade = 'A';
    reasons.push(`${(reviewCount/1000).toFixed(0)}K+ reviews — too many to fake at scale`);
  } else if (reviewCount >= 1000 && rating >= 4.0 && rating <= 4.7) {
    score = 75; grade = 'B';
    reasons.push(`${reviewCount} reviews with realistic ${rating}★ rating`);
  } else if (reviewCount >= 200) {
    score = 60; grade = 'C';
    reasons.push(`${reviewCount} reviews — moderate, check manually`);
  } else if (reviewCount >= 50) {
    score = 40; grade = 'D';
    reasons.push(`Only ${reviewCount} reviews — unproven product ⚠️`);
  } else {
    score = 20; grade = 'F';
    reasons.push(`Under 50 reviews — too risky, could be fake or new product ❌`);
  }

  // Suspiciously perfect rating = red flag
  if (rating >= 4.9 && reviewCount < 5000) {
    score -= 15; grade = score >= 60 ? 'C' : 'D';
    reasons.push(`${rating}★ is suspiciously high for ${reviewCount} reviews — possible fake reviews ⚠️`);
  }

  // Rating too low = product quality issue
  if (rating < 3.5) {
    score -= 20; grade = 'F';
    reasons.push(`${rating}★ is below 3.5 — customers unhappy, high returns expected ❌`);
  }

  // Very low BSR + high reviews = strong confirmation
  if (bsr && bsr <= 1000 && reviewCount >= 5000) {
    score = Math.min(score + 10, 100);
    reasons.push('Top 1000 BSR + high reviews = confirmed genuine demand ✅');
  }

  // Verified purchase estimate (typically 90-95% for real products)
  const verifiedPct = reviewCount >= 5000 ? 95 : reviewCount >= 1000 ? 90 : reviewCount >= 200 ? 85 : 70;
  reasons.push(`Estimated ${verifiedPct}% verified purchase reviews`);

  return { score, grade, reasons, verifiedPct };
}

// Return rate analysis
function analyseReturnRate(category, rating) {
  const catKey = Object.keys(RETURN_RATES).find(k => (category||'').includes(k)) || 'default';
  let baseRate = RETURN_RATES[catKey];

  // Adjust based on rating
  if (rating >= 4.5) baseRate *= 0.7; // Good rating = fewer returns
  else if (rating >= 4.0) baseRate *= 0.9;
  else if (rating < 3.5) baseRate *= 1.8; // Bad rating = more returns

  baseRate = parseFloat(baseRate.toFixed(1));

  let level, message;
  if (baseRate <= 3) { level = 'excellent'; message = `${baseRate}% expected returns — very low, quality product ✅`; }
  else if (baseRate <= 5) { level = 'good'; message = `${baseRate}% expected returns — normal for category ✅`; }
  else if (baseRate <= 8) { level = 'moderate'; message = `${baseRate}% expected returns — watch closely ⚠️`; }
  else if (baseRate <= 15) { level = 'high'; message = `${baseRate}% expected returns — cuts into profit ⚠️`; }
  else { level = 'very_high'; message = `${baseRate}% expected returns — too risky ❌`; }

  return { rate: baseRate, level, message, categoryBenchmark: RETURN_RATES[catKey] };
}

// YouTube review check generator
function getYouTubeReviewLinks(productName) {
  const q = (productName || '').split(' ').slice(0, 5).join(' ');
  return {
    searchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' review')}`,
    suggestion: `Search YouTube for "${q} review" to see real people testing this product`,
  };
}

// ReviewMeta link generator
function getReviewMetaLink(asin) {
  if (!asin) return null;
  return `https://reviewmeta.com/amazon-uk/${asin}`;
}

// Fakespot link generator
function getFakespotLink(asin) {
  if (!asin) return null;
  return `https://www.fakespot.com/analyze?url=https://www.amazon.co.uk/dp/${asin}`;
}

// Private label detection
function detectPrivateLabel(sellerCount, brandName, amazonSells) {
  const reasons = [];
  let isBlocked = false;

  // If only 1 seller, likely private label — can't arbitrage
  if (sellerCount !== null && sellerCount <= 1) {
    isBlocked = true;
    reasons.push('Only 1 FBA seller — likely private label/trademarked');
  }

  // Known big brands that block resellers or are gated
  const blockedBrands = ['apple','nike','adidas','samsung','sony','dyson','bose','lego','disney','nintendo','philips',
    'panasonic','logitech','anker','jbl','kitchenaid','nespresso','braun','oral-b','gillette','hasbro','mattel',
    'crocs','north face','under armour','puma','new balance'];
  if (brandName && blockedBrands.some(b => brandName.toLowerCase().includes(b))) {
    isBlocked = true;
    reasons.push(`${brandName} is a restricted/gated brand`);
  }

  // Amazon as seller = they'll win Buy Box
  if (amazonSells) {
    reasons.push('Amazon is a direct seller — they dominate Buy Box');
  }

  if (!isBlocked && !amazonSells) {
    if (sellerCount && sellerCount >= 2) {
      reasons.push(`${sellerCount} FBA sellers — open for arbitrage`);
    } else if (sellerCount === null) {
      reasons.push('Seller data unavailable — verify manually');
    }
  }

  return {
    isPrivateLabel: isBlocked,
    amazonSells: !!amazonSells,
    message: isBlocked ? `❌ ${reasons[0]}` : (amazonSells ? `⚠️ ${reasons[0]}` : `✅ ${reasons.join('. ')}`),
    reasons,
  };
}

// Competition assessment
function assessCompetition(d) {
  let score = 100; // start perfect, deduct for risks
  let reasons = [];

  // Amazon as seller = very hard to win Buy Box
  if (d.amazonSells) {
    score -= 40;
    reasons.push('Amazon is a seller — very hard to win Buy Box ❌');
  }

  // Seller count
  const sellers = d.sellerCount || 0;
  if (sellers === 0) {
    reasons.push('Seller count unknown — check manually ⚠️');
  } else if (sellers <= 2) {
    score -= 5;
    reasons.push(`${sellers} FBA sellers — low competition ✅`);
  } else if (sellers <= 5) {
    score -= 10;
    reasons.push(`${sellers} FBA sellers — moderate competition`);
  } else if (sellers <= 10) {
    score -= 25;
    reasons.push(`${sellers} FBA sellers — crowded ⚠️`);
  } else {
    score -= 40;
    reasons.push(`${sellers} FBA sellers — race to bottom ❌`);
  }

  // Price stability
  if (d.priceStability !== null) {
    if (d.priceStability >= 85) {
      reasons.push(`Price ${d.priceStability}% stable over 90 days ✅`);
    } else if (d.priceStability >= 70) {
      score -= 10;
      reasons.push(`Price ${d.priceStability}% stable — some fluctuation ⚠️`);
    } else {
      score -= 25;
      reasons.push(`Price only ${d.priceStability}% stable — volatile, margin risk ❌`);
    }
    if (d.priceMin90 && d.priceMax90) {
      reasons.push(`90-day range: £${d.priceMin90} — £${d.priceMax90}`);
    }
  }

  score = Math.max(score, 0);
  let level = score >= 70 ? 'good' : score >= 40 ? 'moderate' : 'risky';
  return { score, level, reasons };
}

// Seasonality check
function checkSeasonality(category, productName) {
  const month = new Date().getMonth(); // 0-11
  const name = (productName || '').toLowerCase();
  const cat = (category || '').toLowerCase();

  // Seasonal keywords
  if (name.includes('bbq') || name.includes('grill') || name.includes('thermometer')) {
    const peak = month >= 3 && month <= 8; // Apr-Sep
    return { seasonal: true, peak, message: peak ? '✅ Peak BBQ season now — high demand' : '⚠️ Off-season for BBQ products — demand lower until spring' };
  }
  if (name.includes('christmas') || name.includes('xmas') || name.includes('advent')) {
    const peak = month >= 9 && month <= 11;
    return { seasonal: true, peak, message: peak ? '✅ Christmas season — peak demand' : '❌ Off-season for Christmas products' };
  }
  if (name.includes('pool') || name.includes('swim') || name.includes('sun cream')) {
    const peak = month >= 4 && month <= 7;
    return { seasonal: true, peak, message: peak ? '✅ Summer season' : '⚠️ Off-season for summer products' };
  }
  if (name.includes('heater') || name.includes('blanket') || name.includes('thermal')) {
    const peak = month >= 9 || month <= 2;
    return { seasonal: true, peak, message: peak ? '✅ Winter season — high demand' : '⚠️ Off-season for winter products' };
  }
  // General kitchen/home = year-round
  if (cat.includes('kitchen') || cat.includes('home')) {
    return { seasonal: false, peak: true, message: '✅ Year-round demand — not seasonal' };
  }
  return { seasonal: false, peak: true, message: '✅ No strong seasonality detected' };
}

// Complete quality assessment
function assessQuality(d) {
  const reviewAuth = analyseReviewAuthenticity(d.reviewCount || 0, parseFloat(d.rating || 0), d.salesRank || d.bsr);
  const returnRate = analyseReturnRate(d.category, parseFloat(d.rating || 0));
  const youtube = getYouTubeReviewLinks(d.name);
  const reviewMeta = getReviewMetaLink(d.asin);
  const fakespot = getFakespotLink(d.asin);
  const privateLabel = detectPrivateLabel(d.sellerCount, d.brand, d.amazonSells);
  const season = checkSeasonality(d.category, d.name);

  // Overall quality score (0-100)
  let qualityScore = 0;
  qualityScore += reviewAuth.score * 0.35; // 35% review authenticity
  qualityScore += (returnRate.rate <= 5 ? 30 : returnRate.rate <= 8 ? 20 : returnRate.rate <= 12 ? 10 : 0); // 30% return rate
  qualityScore += (privateLabel.isPrivateLabel ? 0 : 20); // 20% not private label
  qualityScore += (season.peak ? 15 : 5); // 15% seasonality
  qualityScore = Math.round(Math.min(qualityScore, 100));

  let qualityLevel;
  if (qualityScore >= 75) qualityLevel = 'verified';
  else if (qualityScore >= 55) qualityLevel = 'likely_good';
  else if (qualityScore >= 35) qualityLevel = 'uncertain';
  else qualityLevel = 'risky';

  return {
    qualityScore, qualityLevel,
    reviewAuth, returnRate, youtube, reviewMeta, fakespot,
    privateLabel, season,
    testBuyRecommendation: qualityScore < 75
      ? '⚠️ Recommend buying 1 unit first to test quality before bulk order'
      : '✅ High confidence — safe to order full quantity',
  };
}

// ═══════════════════════════════════════
// FEE ENGINE (2026 UK)
// ═══════════════════════════════════════
function calcFees(sp, wt, cat) {
  let rr;
  if (cat?.includes('Home') && sp <= 20) rr = 0.08;
  else if (cat?.includes('Electro')) rr = 0.08;
  else if (cat?.includes('Clothing') && sp <= 15) rr = 0.05;
  else if (cat?.includes('Clothing') && sp <= 20) rr = 0.10;
  else if (cat?.includes('Pet') && sp <= 10) rr = 0.05;
  else if (sp <= 20) rr = 0.08;
  else rr = 0.15;
  const rf = Math.max(sp * rr, 0.25);
  let ff = wt<=0.15?2.19:wt<=0.4?2.33:wt<=0.9?2.82:wt<=1.5?3.35:wt<=3?4.10:wt<=6?4.85:5.60+(wt-6)*0.40;
  const mo = new Date().getMonth();
  const sr = (mo>=9&&mo<=11) ? 2.40 : 0.78;
  const cf = Math.max(wt*0.5,0.1);
  const sf = parseFloat((cf*sr).toFixed(2));
  return { rr:(rr*100).toFixed(0)+'%', rf:parseFloat(rf.toFixed(2)), ff:parseFloat(ff.toFixed(2)), sf, cf:parseFloat(cf.toFixed(2)) };
}
function calcPrep(bw) { return { l:0.35, p:bw?0.20:0, b:0.15, t:parseFloat((0.50+(bw?0.20:0)).toFixed(2)) }; }
function calcSurcharge(days, cf) {
  if(days<=270) return {s:0,level:'safe',msg:`✅ ${270-days}d until surcharge`};
  if(days<=300) return {s:parseFloat((2.32*cf).toFixed(2)),level:'caution',msg:'⚠️ Surcharge started'};
  if(days<=365) return {s:parseFloat((2.48*cf).toFixed(2)),level:'danger',msg:`🔴 ${365-days}d until penalty`};
  return {s:parseFloat((5.71*cf).toFixed(2)),level:'critical',msg:'🚨 PENALTY — remove NOW'};
}

function analyse(d, budget) {
  d._budget = budget; // pass through for storage calc
  const bp=d.buyPrice||0, rawSp=d.sellPrice||0, wt=d.weightKg||0.3, cat=d.category||'Home & Kitchen';
  // Realistic sell price: you rarely win Buy Box at full price — assume 3% lower
  const sp = parseFloat((rawSp * 0.97).toFixed(2));
  const amz=calcFees(sp,wt,cat), prep=calcPrep(d.bubbleWrap||d.fragile||false);
  // Import costs for China-sourced products
  const isChina = !!(  (d.from||'').toLowerCase().match(/ali|temu|bang|dh/) || (d.buyUrl||'').match(/aliexpress|alibaba|temu|banggood|dhgate/i)  );
  const importVAT = isChina ? parseFloat((bp * 0.20).toFixed(2)) : 0; // 20% VAT on imports
  const importDuty = isChina ? parseFloat((bp * 0.04).toFixed(2)) : 0; // avg 2-6% duty on consumer goods
  const shippingToPrep = isChina ? 0 : parseFloat((wt * 2.50).toFixed(2)); // UK sources: ~£2.50/kg delivery
  // Storage: multiply by estimated months to sell
  const salesEst = estimateSales(d.salesRank || d.bsr, cat);
  const estMonthsToSell = salesEst.monthly > 0 ? Math.max(Math.ceil((bp>0?Math.floor((d._budget||200)/bp):10) / salesEst.monthly), 1) : 3;
  const totalStorage = parseFloat((amz.sf * estMonthsToSell).toFixed(2));
  const tc=parseFloat((bp+importVAT+importDuty+shippingToPrep+prep.t+amz.rf+amz.ff+totalStorage).toFixed(2));
  const pr=parseFloat((sp-tc).toFixed(2));
  const mg=sp>0?parseFloat(((pr/sp)*100).toFixed(1)):0;
  const u=bp>0?Math.floor(budget/bp):0;
  const bpr=parseFloat((u*pr).toFixed(2));
  const roi=bp>0?parseFloat(((pr/bp)*100).toFixed(0)):0;

  // Time to sell estimate (needed early for tax projection)
  const timeToSell = salesEst.monthly > 0 ? Math.ceil(u / Math.max(salesEst.monthly, 1)) : 99;

  // Demand assessment (salesEst computed above for storage calc)
  const demand = assessDemand(d.salesRank || d.bsr || 999999, d.reviewCount || 0, parseFloat(d.rating || 0), salesEst);

  // Quality verification
  const quality = assessQuality(d);

  // Competition analysis
  const competition = assessCompetition(d);

  // Return rate impact on profit — a return costs you the FULL product cost
  // You refund the customer (lose sell price), keep unsellable item, and pay return processing fee
  const returnRate = quality.returnRate.rate / 100;
  const returnProcessingFee = 2.50; // Amazon UK return processing fee
  const costPerReturn = tc + returnProcessingFee; // total cost of product + return fee (sell price refunded)
  const expectedReturns = u * returnRate;
  const returnCost = parseFloat((expectedReturns * costPerReturn).toFixed(2));
  const adjustedBatchProfit = parseFloat((u * pr - returnCost).toFixed(2));
  const adjustedProfit = u > 0 ? parseFloat((adjustedBatchProfit / u).toFixed(2)) : 0;

  // Tax calculations (UK self-employed) — project annual profit to apply correct rates
  // If you repeat this deal monthly for 12 months, what's the annual profit?
  const annualProjection = adjustedBatchProfit * (12 / Math.max(timeToSell, 1));
  const toolCostsAnnual = 100 * 12; // Keepa + tools ~£100/mo deductible
  const taxableAnnual = Math.max(annualProjection - toolCostsAnnual, 0);
  // Effective tax rate based on personal allowance (£12,570)
  const effectiveTaxRate = taxableAnnual <= 12570 ? 0 : ((taxableAnnual - 12570) * 0.20) / taxableAnnual;
  const effectiveNIRate = taxableAnnual <= 12570 ? 0 : ((taxableAnnual - 12570) * 0.09) / taxableAnnual;
  const incomeTax = parseFloat((adjustedBatchProfit * effectiveTaxRate).toFixed(2));
  const nationalInsurance = parseFloat((adjustedBatchProfit * effectiveNIRate).toFixed(2));
  const netAfterTax = parseFloat((adjustedBatchProfit - incomeTax - nationalInsurance).toFixed(2));

  // Combined score: profit (25%) + demand (30%) + quality (25%) + competition (20%)
  const profitScore = Math.min(Math.round(Math.min(mg*1.2,40)+Math.min(roi*0.2,30)+(pr>3?20:pr>1?10:0)+10),100);
  const combinedScore = Math.round(profitScore * 0.25 + demand.score * 0.30 + quality.qualityScore * 0.25 + competition.score * 0.20);

  // Reinvestment projection — realistic with lead time + sell-through
  // China sourcing: ~3 week lead time. UK: ~1 week. Sell-through varies.
  const leadTimeMonths = isChina ? 1 : 0.5;
  const cycleMonths = Math.max(timeToSell, 1) + leadTimeMonths; // order → sold out cycle
  const cyclesPerYear = Math.min(12 / cycleMonths, 6); // max 6 cycles/year
  const reinvestment = [];
  let runningBudget = budget;
  let monthCursor = 0;
  for (let c = 1; c <= Math.min(Math.ceil(cyclesPerYear), 6); c++) {
    monthCursor += cycleMonths;
    const mUnits = Math.floor(runningBudget / (bp || 1));
    const mGross = mUnits * pr;
    const mReturnLoss = mUnits * returnRate * costPerReturn;
    const mProfit = mGross - mReturnLoss;
    const mTax = mProfit * (effectiveTaxRate + effectiveNIRate);
    const mNet = mProfit - mTax;
    runningBudget += mNet;
    reinvestment.push({ month: parseFloat(monthCursor.toFixed(1)), cycle: c, units: mUnits, profit: parseFloat(mProfit.toFixed(2)), net: parseFloat(mNet.toFixed(2)), total: parseFloat(runningBudget.toFixed(2)) });
  }

  // Final recommendation — must pass ALL checks
  let rec;
  let passedChecks = 0;
  const totalChecks = 8;
  if (pr > 0) passedChecks++;
  if (mg >= 15) passedChecks++; // minimum 15% margin
  if (demand.level !== 'skip') passedChecks++;
  if (quality.qualityLevel !== 'risky') passedChecks++;
  if (!quality.privateLabel.isPrivateLabel) passedChecks++;
  if (quality.season.peak) passedChecks++;
  if (quality.returnRate.rate <= 10) passedChecks++;
  if (competition.level !== 'risky') passedChecks++;

  if (passedChecks === totalChecks && combinedScore >= 70)
    rec = `✅ STRONG BUY — ${u} units, ~${timeToSell}mo to sell, £${netAfterTax.toFixed(0)} net profit after tax`;
  else if (passedChecks >= 5 && combinedScore >= 55)
    rec = `✅ BUY — ${u} units, £${netAfterTax.toFixed(0)} net after tax`;
  else if (passedChecks >= 4 && combinedScore >= 40)
    rec = `⚠️ CAUTION — passed ${passedChecks}/${totalChecks} checks, review manually`;
  else if (quality.privateLabel.isPrivateLabel)
    rec = '❌ BLOCKED — private label product, cannot arbitrage';
  else if (!d.buyPrice || pr <= 0)
    rec = '❌ NOT PROFITABLE';
  else
    rec = `❌ SKIP — only passed ${passedChecks}/${totalChecks} checks`;

  return {
    ...d, amz, prep, tc, pr, mg, u, bpr, roi, score: combinedScore, profitable: pr > 0,
    realisticSellPrice: sp, rawSellPrice: rawSp,
    demand, salesEst, timeToSell, profitScore, demandScore: demand.score,
    quality, competition, returnCost, adjustedProfit, adjustedBatchProfit,
    importVAT, importDuty, totalStorage, isChina: !!isChina,
    incomeTax, nationalInsurance, netAfterTax, reinvestment,
    passedChecks, totalChecks, rec,
  };
}

// ═══════════════════════════════════════
// KEEPA API
// ═══════════════════════════════════════
async function keepa(asin) {
  const key = process.env.KEEPA_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://api.keepa.com/product?key=${key}&domain=2&asin=${asin}&stats=90&history=1&days=90&rating=1&buybox=1`);
    const d = await r.json();
    if (!d.products?.[0]) return null;
    const p = d.products[0];
    const st = p.stats || {};

    // Count BSR drops in last 90 days (each drop = at least 1 sale)
    let bsrDrops = 0;
    if (p.csv && p.csv[3]) {
      const ranks = p.csv[3];
      for (let i = 2; i < ranks.length; i += 2) {
        if (ranks[i] < ranks[i-2] && ranks[i] > 0) bsrDrops++;
      }
    }

    // Competition analysis
    const sellerCount = p.offers ? p.offers.filter(o => o.condition === 1 && o.isFBA).length : null;
    const amazonSells = p.offers ? p.offers.some(o => o.seller === 'A3P5ROKL5A1OLE') : false; // Amazon UK seller ID
    const buyBoxSeller = st.current?.[18] > 0 ? 'FBA' : (st.current?.[0] > 0 ? 'FBM' : 'none');
    const priceMin90 = st.min90?.[0] > 0 ? (st.min90[0]/100).toFixed(2) : null;
    const priceMax90 = st.max90?.[0] > 0 ? (st.max90[0]/100).toFixed(2) : null;
    const priceStability = (priceMin90 && priceMax90 && parseFloat(priceMax90) > 0)
      ? parseFloat(((1 - (parseFloat(priceMax90) - parseFloat(priceMin90)) / parseFloat(priceMax90)) * 100).toFixed(0))
      : null; // 100 = perfectly stable, <70 = volatile

    return {
      asin: p.asin, title: p.title,
      brand: p.brand || null,
      price: st.current?.[0]>0 ? (st.current[0]/100).toFixed(2) : null,
      avg90: st.avg90?.[0]>0 ? (st.avg90[0]/100).toFixed(2) : null,
      bsr: st.current?.[3] || null,
      reviewCount: p.csv?.[16] ? p.csv[16][p.csv[16].length-1] : null,
      rating: p.csv?.[17] ? (p.csv[17][p.csv[17].length-1]/10).toFixed(1) : null,
      category: p.categoryTree ? p.categoryTree.map(c=>c.name).join(' > ') : null,
      weight: p.packageWeight ? (p.packageWeight/1000).toFixed(2) : null,
      buyBox: st.current?.[18]>0 ? (st.current[18]/100).toFixed(2) : null,
      bsrDrops90d: bsrDrops,
      estimatedSales90d: Math.round(bsrDrops * 1.5),
      // Competition data
      sellerCount, amazonSells, buyBoxSeller,
      priceMin90, priceMax90, priceStability,
      tokens: d.tokensLeft,
    };
  } catch(e) { log('Keepa error: '+e.message); return null; }
}

async function keepaBestSellers(catId) {
  const key = process.env.KEEPA_API_KEY;
  if (!key) return [];
  try {
    const r = await fetch(`https://api.keepa.com/bestsellers?key=${key}&domain=2&category=${catId}`);
    const d = await r.json();
    return d.bestSellersList || [];
  } catch(e) { return []; }
}

// ═══════════════════════════════════════
// GLOBAL SOURCES
// ═══════════════════════════════════════
// ═══════════════════════════════════════
// CJDROPSHIPPING API — Real China wholesale prices
// Free API, sign up: https://cjdropshipping.com
// ═══════════════════════════════════════
async function cjSearch(keyword, limit = 5) {
  const key = process.env.CJ_API_KEY;
  if (!key) return null;
  try {
    // Get access token
    const authRes = await fetch('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.CJ_EMAIL, password: process.env.CJ_PASSWORD }),
    });
    const auth = await authRes.json();
    if (!auth.data?.accessToken) return null;
    const token = auth.data.accessToken;

    // Search products
    const res = await fetch('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': token },
      body: JSON.stringify({ productNameEn: keyword, pageNum: 1, pageSize: limit }),
    });
    const data = await res.json();
    if (!data.data?.list?.length) return null;

    return data.data.list.map(p => ({
      name: p.productNameEn,
      price: parseFloat(p.sellPrice || 0),
      image: p.productImage,
      url: `https://cjdropshipping.com/product/${p.pid}.html`,
      variants: (p.variants || []).map(v => ({ name: v.variantNameEn, price: parseFloat(v.variantSellPrice || 0) })),
      shipping: p.shippingPrice || null,
      pid: p.pid,
    }));
  } catch (e) { log('CJ search error: ' + e.message); return null; }
}

// Place order on CJ (ship to prep centre)
async function cjOrder(pid, quantity, shippingAddress) {
  const key = process.env.CJ_API_KEY;
  if (!key) return { error: 'CJ_API_KEY not set' };
  try {
    const authRes = await fetch('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.CJ_EMAIL, password: process.env.CJ_PASSWORD }),
    });
    const auth = await authRes.json();
    const token = auth.data?.accessToken;
    if (!token) return { error: 'Auth failed' };

    const res = await fetch('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrder', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': token },
      body: JSON.stringify({
        products: [{ vid: pid, quantity }],
        shippingAddress,
      }),
    });
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ═══════════════════════════════════════
// AMAZON SP-API — Auto-list products & track sales
// Free with £25/mo seller account
// Setup: https://developer-docs.amazon.com/sp-api
// ═══════════════════════════════════════
const crypto = require('crypto');

async function spApiToken() {
  if (!process.env.SP_REFRESH_TOKEN || !process.env.SP_CLIENT_ID) return null;
  try {
    const res = await fetch('https://api.amazon.co.uk/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.SP_REFRESH_TOKEN,
        client_id: process.env.SP_CLIENT_ID,
        client_secret: process.env.SP_CLIENT_SECRET,
      }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch (e) { log('SP-API token error: ' + e.message); return null; }
}

async function spApiCall(method, endpoint, body = null) {
  const token = await spApiToken();
  if (!token) return null;
  try {
    const opts = {
      method,
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://sellingpartnerapi-eu.amazon.com${endpoint}`, opts);
    return await res.json();
  } catch (e) { log('SP-API error: ' + e.message); return null; }
}

// Match to existing ASIN and create offer (for arbitrage — you sell same product)
async function spApiCreateOffer(asin, price, condition = 'new_new') {
  const sku = `FBA-${asin}-${Date.now()}`;
  return spApiCall('PUT', `/listings/2021-08-01/items/${process.env.SP_SELLER_ID}/${sku}`, {
    productType: 'PRODUCT',
    requirements: 'LISTING_OFFER_ONLY',
    attributes: {
      condition_type: [{ value: condition }],
      merchant_suggested_asin: [{ value: asin }],
      purchasable_offer: [{
        currency: 'GBP',
        our_price: [{ schedule: [{ value_with_tax: price }] }],
      }],
      fulfillment_availability: [{
        fulfillment_channel_code: 'AMAZON_EU',
      }],
    },
  });
}

// Get sales/orders for last N days
async function spApiGetOrders(daysBack = 30) {
  const after = new Date(Date.now() - daysBack * 86400000).toISOString();
  return spApiCall('GET', `/orders/v0/orders?MarketplaceIds=A1F83G8C2ARO7P&CreatedAfter=${after}&FulfillmentChannels=AFN`);
}

// Get FBA inventory levels
async function spApiGetInventory() {
  return spApiCall('GET', '/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=A1F83G8C2ARO7P&marketplaceIds=A1F83G8C2ARO7P');
}

// Get competitive pricing for an ASIN
async function spApiGetPricing(asin) {
  return spApiCall('GET', `/products/pricing/v0/competitivePrice?MarketplaceId=A1F83G8C2ARO7P&Asins=${asin}&ItemType=Asin`);
}

const SOURCES = [
  { name:'AliExpress', region:'🇨🇳', ship:'Free', days:'10-20', url:q=>`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(q)}.html` },
  { name:'Alibaba', region:'🇨🇳', ship:'£2-5/kg', days:'15-30', url:q=>`https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(q)}` },
  { name:'Temu', region:'🇨🇳', ship:'Free', days:'7-15', url:q=>`https://www.temu.com/search_result.html?search_key=${encodeURIComponent(q)}` },
  { name:'Banggood', region:'🇨🇳', ship:'Free', days:'10-25', url:q=>`https://www.banggood.com/search/${encodeURIComponent(q)}.html` },
  { name:'DHgate', region:'🇨🇳', ship:'Free', days:'12-25', url:q=>`https://www.dhgate.com/wholesale/search.do?searchkey=${encodeURIComponent(q)}` },
  { name:'Argos Clearance', region:'🇬🇧', ship:'Free/£3.95', days:'1-3', url:q=>`https://www.argos.co.uk/search/${encodeURIComponent(q)}/opt/sort:price` },
  { name:'Currys Deals', region:'🇬🇧', ship:'Free', days:'1-3', url:q=>`https://www.currys.co.uk/search/${encodeURIComponent(q)}` },
  { name:'Amazon Warehouse', region:'🇬🇧', ship:'Free Prime', days:'1-2', url:q=>`https://www.amazon.co.uk/s?k=${encodeURIComponent(q)}&i=warehouse-deals` },
  { name:'John Lewis Sale', region:'🇬🇧', ship:'Free £50+', days:'2-5', url:q=>`https://www.johnlewis.com/search?search-term=${encodeURIComponent(q)}&sale=true` },
  { name:'Boots', region:'🇬🇧', ship:'£3.50', days:'2-4', url:q=>`https://www.boots.com/search/${encodeURIComponent(q)}` },
  { name:'B&M', region:'🇬🇧', ship:'In-store', days:'0', url:q=>`https://www.bmstores.co.uk/search?query=${encodeURIComponent(q)}` },
];

function getSources(name) {
  const q = (name||'').split(' ').slice(0,5).join(' ');
  return SOURCES.map(s => ({ ...s, url: s.url(q) }));
}

// ═══════════════════════════════════════
// TACTICAL ARBITRAGE INTEGRATION
// TA scans 1000+ stores for price gaps. Sends email alerts + CSV exports.
// This parses TA emails to extract REAL buy prices and creates deals automatically.
// Also accepts CSV upload from TA's export feature.
// ═══════════════════════════════════════

// Parse Tactical Arbitrage email content for product data
function parseTAEmail(subject, snippet, body) {
  const deals = [];
  const text = (subject + ' ' + snippet + ' ' + (body || '')).replace(/\s+/g, ' ');

  // TA emails typically contain: ASIN, product name, source store, buy price, sell price, profit, ROI, BSR
  // Pattern 1: "B0XXXXXXXX ... $XX.XX ... £XX.XX ... XX% ROI ... BSR #XXXX"
  const asinMatches = [...new Set(text.match(/\bB0[A-Z0-9]{8}\b/g) || [])];

  // Extract prices — TA often formats as "£5.99 → £19.99" or "Buy: £5.99 Sell: £19.99"
  const prices = text.match(/[£$]\d+\.?\d*/g) || [];
  const rois = text.match(/(\d+\.?\d*)%\s*(?:ROI|profit|margin)/gi) || [];
  const bsrMatch = text.match(/BSR[:#\s]*(\d[\d,]*)/i);
  const sourceMatch = text.match(/(?:from|source|store|at|via)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9\s&'.]+?)(?:\s*[-–|,]|\s*£|\s*\$|\s*B0)/i);

  for (const asin of asinMatches) {
    const deal = { asin, fromTA: true };
    // Try to extract buy price (usually the lower price)
    if (prices.length >= 2) {
      const nums = prices.map(p => parseFloat(p.replace(/[£$]/,'')));
      nums.sort((a,b) => a - b);
      deal.taBuyPrice = nums[0]; // cheapest = buy
      deal.taSellPrice = nums[nums.length > 2 ? nums.length - 1 : 1]; // highest = sell
    }
    if (bsrMatch) deal.taBsr = parseInt(bsrMatch[1].replace(/,/g,''));
    if (sourceMatch) deal.taSource = sourceMatch[1].trim();
    if (rois.length) deal.taROI = parseFloat(rois[0]);
    deals.push(deal);
  }
  return deals;
}

// Parse Tactical Arbitrage CSV export
function parseTACSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // TA CSV headers typically: ASIN, Title, Category, Buy Price, Sell Price, Profit, ROI, BSR, Source, URL, FBA Fees, etc.
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const deals = [];

  for (let i = 1; i < lines.length; i++) {
    // Handle CSV with quoted fields
    const vals = [];
    let current = '', inQuote = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { vals.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    vals.push(current.trim());

    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });

    // Map TA fields to our deal format
    const asin = row.asin || row['amazon asin'] || row['asin '] || '';
    if (!/^B0[A-Z0-9]{8}$/.test(asin)) continue;

    const buyPrice = parseFloat(row['buy price'] || row['source price'] || row['cost'] || row.price || 0);
    const sellPrice = parseFloat(row['sell price'] || row['amazon price'] || row['fba price'] || 0);
    if (!buyPrice || !sellPrice) continue;

    deals.push({
      asin,
      name: row.title || row['product name'] || row.name || 'TA Import',
      buyPrice,
      sellPrice,
      category: row.category || 'Home & Kitchen',
      bsr: parseInt(row.bsr || row['sales rank'] || row['best sellers rank'] || 0),
      roi: parseFloat(row.roi || row['roi %'] || 0),
      profit: parseFloat(row.profit || row['est. profit'] || 0),
      source: row.source || row['source store'] || row.store || 'Tactical Arbitrage',
      sourceUrl: row['source url'] || row['buy link'] || row.url || '',
      fbaFees: parseFloat(row['fba fees'] || row['amazon fees'] || row.fees || 0),
      fromTA: true,
    });
  }
  return deals;
}

// ═══════════════════════════════════════
// GMAIL (every 2 minutes)
// ═══════════════════════════════════════
let gAuth = null;
function gmail() {
  if (!process.env.GMAIL_CLIENT_ID) return null;
  if (!gAuth) {
    gAuth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, 'http://localhost:3000/auth/callback');
    gAuth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  }
  return gAuth;
}

async function checkGmail() {
  const auth = gmail();
  if (!auth) return { alerts:[], error:'Gmail not configured' };
  try {
    const g = google.gmail({version:'v1',auth});
    const q = 'newer_than:4h (tactical arbitrage OR deal alert OR profitable OR FBA OR arbitrage OR price drop OR product alert)';
    const list = await g.users.messages.list({userId:'me',q,maxResults:20});
    if (!list.data.messages?.length) { S.lastGmailCheck=new Date().toISOString(); save(S); return {alerts:[],msg:'No new alerts'}; }

    const newAlerts = [];
    for (const msg of list.data.messages.slice(0,10)) {
      if ((S.processed||[]).includes(msg.id)) continue;
      const full = await g.users.messages.get({userId:'me',id:msg.id,format:'metadata',metadataHeaders:['Subject','From','Date']});
      const h = full.data.payload?.headers || [];
      const alert = {
        id: msg.id,
        subject: h.find(x=>x.name==='Subject')?.value||'',
        from: h.find(x=>x.name==='From')?.value||'',
        date: h.find(x=>x.name==='Date')?.value||'',
        snippet: full.data.snippet||'',
      };

      // Check if this is a Tactical Arbitrage email
      const isTA = (alert.from + alert.subject).toLowerCase().includes('tactical arbitrage') ||
                   alert.from.includes('tacticalarbitrage') || alert.from.includes('tactarb');
      const taDeals = isTA ? parseTAEmail(alert.subject, alert.snippet) : [];

      // Auto-extract ASINs and look up
      const asins = [...new Set(((alert.snippet+' '+alert.subject).match(/\bB0[A-Z0-9]{8}\b/g)||[]))];
      if (asins.length > 0 && process.env.KEEPA_API_KEY) {
        for (const asin of asins.slice(0,3)) {
          const k = await keepa(asin);
          if (k?.price) {
            const sp = parseFloat(k.price);
            // Use TA's REAL buy price if available, otherwise estimate from China
            const taMatch = taDeals.find(td => td.asin === asin);
            const buyPrice = taMatch?.taBuyPrice || parseFloat((sp * 0.25).toFixed(2));
            const fromSource = taMatch?.taSource || 'AliExpress (est.)';
            const isRealPrice = !!taMatch?.taBuyPrice;

            const deal = {
              id: Date.now()+Math.random(), name: k.title, asin, sellPrice: sp,
              buyPrice, estBuyPrice: parseFloat((sp * 0.25).toFixed(2)),
              weightKg: parseFloat(k.weight||0.3), category: k.category||'Home & Kitchen',
              brand: k.brand, sellerCount: k.sellerCount, amazonSells: k.amazonSells,
              priceStability: k.priceStability, priceMin90: k.priceMin90, priceMax90: k.priceMax90,
              reviewCount: k.reviewCount, rating: k.rating, salesRank: k.bsr,
              bsrDrops90d: k.bsrDrops90d, estimatedSales90d: k.estimatedSales90d,
              reviews: k.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
              from: fromSource, sources: getSources(k.title),
              amzUrl: `https://www.amazon.co.uk/dp/${asin}`,
              note: isTA
                ? `Tactical Arbitrage find! Buy £${buyPrice} from ${fromSource} → Sell £${sp} on Amazon. BSR #${k.bsr}. ${isRealPrice?'VERIFIED price.':'Estimated price.'}`
                : `From alert. £${sp} Amazon, buy ~£${buyPrice}. BSR #${k.bsr}. ~${k.estimatedSales90d} sales/90d.`,
              risks: isRealPrice ? ['Check product matches Amazon listing exactly'] : ['Verify buy price before ordering'],
              src: isTA ? `Tactical Arbitrage → Keepa (${new Date().toLocaleDateString('en-GB')})` : `Gmail → Keepa (${new Date().toLocaleDateString('en-GB')})`,
              autoFound: true, needsPrice: false, fromTA: isTA, taVerified: isRealPrice,
            };

            // Pre-analyse and only keep profitable deals
            const analysed = analyse(deal, S.budget || 200);
            if (analysed.score >= 55 && analysed.pr > 2 && analysed.passedChecks >= 5) {
              S.deals = S.deals || [];
              S.deals.unshift(deal);
              log(`✅ ${isTA?'TA':'Gmail'}: ${k.title} — £${analysed.pr} profit, score ${analysed.score}, ${analysed.passedChecks}/${analysed.totalChecks}${isRealPrice?' (verified price)':''}`);
            } else {
              log(`❌ Skipped: ${k.title} — score ${analysed.score}, profit £${analysed.pr}`);
            }
          }
          await new Promise(r=>setTimeout(r,2000));
        }
      }
      newAlerts.push(alert);
      S.processed = [...(S.processed||[]),msg.id].slice(-500);
    }
    S.alerts = [...newAlerts,...(S.alerts||[])].slice(0,100);
    S.lastGmailCheck = new Date().toISOString();
    save(S);
    return { alerts: newAlerts, msg: `${newAlerts.length} checked` };
  } catch(e) { log('Gmail: '+e.message); return {alerts:[],error:e.message}; }
}

// ═══════════════════════════════════════
// AUTO SCANNER (every 2 hours — aggressive)
// Scans 12 Amazon UK categories for profitable products
// ═══════════════════════════════════════
const SCAN_CATEGORIES = [
  [11052591, 'Home & Kitchen'], [560800, 'Kitchen & Home'],
  [364301031, 'Pet Supplies'], [319530011, 'Sports & Outdoors'],
  [77028031, 'Baby Products'], [66280031, 'Beauty'],
  [468292, 'Toys & Games'], [65801031, 'Health & Personal Care'],
  [3146281, 'Garden & Outdoors'], [248877031, 'DIY & Tools'],
  [560798, 'Lighting'], [2151888031, 'Stationery & Office'],
];

async function autoScan() {
  if (!process.env.KEEPA_API_KEY) return;
  log('🔍 Auto-scanning ' + SCAN_CATEGORIES.length + ' categories...');
  let found = 0;
  for (const [catId, catName] of SCAN_CATEGORIES) {
    try {
      const asins = await keepaBestSellers(catId);
      if (!asins?.length) continue;
      for (const asin of asins.slice(0,8)) {
        if ((S.deals||[]).find(d=>d.asin===asin)) continue;
        const k = await keepa(asin);
        if (!k?.price) continue;
        const sp = parseFloat(k.price);
        if (sp < 5 || sp > 50) continue;

        const salesEst = estimateSales(k.bsr, k.category);
        const demand = assessDemand(k.bsr||999999, k.reviewCount||0, parseFloat(k.rating||0), salesEst);
        if (demand.level === 'skip') continue;
        if (demand.score < 50) continue; // Only high-demand products

        // Skip if Amazon is a seller — can't compete
        if (k.amazonSells) { log(`⏭️ Skip: ${k.title} — Amazon is seller`); continue; }

        // Estimate buy price: China wholesale is typically 20-35% of Amazon UK price
        const estBuyPrice = parseFloat((sp * 0.25).toFixed(2));
        const competition = assessCompetition(k);
        if (competition.level === 'risky') { log(`⏭️ Skip: ${k.title} — high competition`); continue; }

        const deal = {
          id: Date.now()+Math.random(), name: k.title, asin, sellPrice: sp,
          buyPrice: estBuyPrice, estBuyPrice, weightKg: parseFloat(k.weight||0.3), category: k.category||'Home & Kitchen',
          brand: k.brand, sellerCount: k.sellerCount, amazonSells: k.amazonSells,
          priceStability: k.priceStability, priceMin90: k.priceMin90, priceMax90: k.priceMax90,
          reviewCount: k.reviewCount, rating: k.rating, salesRank: k.bsr,
          bsrDrops90d: k.bsrDrops90d, estimatedSales90d: k.estimatedSales90d,
          reviews: k.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
          from: 'AliExpress (est.)', sources: getSources(k.title),
          amzUrl: `https://www.amazon.co.uk/dp/${asin}`,
          note: `Auto-found ${catName}. £${sp} on Amazon, buy ~£${estBuyPrice} from China. BSR #${k.bsr}. ~${k.estimatedSales90d} sales/90d.${k.sellerCount?' '+k.sellerCount+' FBA sellers.':''}`,
          risks: ['Verify buy price on AliExpress/Alibaba before ordering', 'Check product matches Amazon listing exactly'],
          src: `Auto-scan ${catName} (${new Date().toLocaleDateString('en-GB')})`,
          autoFound: true, needsPrice: false,
          status: 'found',
        };

        // Pre-analyse to filter out bad deals BEFORE showing to user
        const analysed = analyse(deal, S.budget || 200);
        if (analysed.score < 55) { log(`⏭️ Skip: ${k.title} — score ${analysed.score} too low`); continue; }
        if (analysed.pr <= 2) { log(`⏭️ Skip: ${k.title} — profit £${analysed.pr} too low`); continue; }
        if (analysed.passedChecks < 5) { log(`⏭️ Skip: ${k.title} — only ${analysed.passedChecks}/${analysed.totalChecks} checks`); continue; }

        S.deals = S.deals||[];
        S.deals.unshift(deal);
        found++;
        log(`✅ Auto: ${k.title} — £${sp} sell, ~£${estBuyPrice} buy, £${analysed.pr} profit, score ${analysed.score}, ${analysed.passedChecks}/${analysed.totalChecks} checks`);
        await new Promise(r=>setTimeout(r,2000));
      }
    } catch(e) { log('Scan error: '+e.message); }
  }
  // Clean up old deals (keep max 50)
  if (S.deals && S.deals.length > 50) S.deals = S.deals.slice(0, 50);
  save(S);
  log(`🔍 Scan complete — ${found} new deals found`);
}

// ═══════════════════════════════════════
// AUTOPILOT ENGINE
// When enabled: auto-approves → auto-orders via CJ → auto-lists on Amazon
// User does NOTHING — just watches profit come in
// ═══════════════════════════════════════
async function runAutopilot() {
  if (!S.autopilot?.enabled) return;
  const ap = S.autopilot;
  const budget = S.budget || 200;
  const todayKey = new Date().toISOString().slice(0, 10);
  S._autopilotSpend = S._autopilotSpend || {};
  const spentToday = S._autopilotSpend[todayKey] || 0;

  log('🤖 Autopilot running...');
  let actions = 0;

  // STEP 1: Auto-approve & auto-order deals that pass threshold
  const deals = (S.deals || []).filter(d => d.status === 'found' && !d.autoApproved);
  for (const deal of deals) {
    const analysed = analyse(deal, budget);
    const passesThreshold = analysed.score >= ap.minScore &&
                            analysed.pr >= ap.minProfit &&
                            analysed.passedChecks >= ap.minChecks &&
                            analysed.profitable;
    if (!passesThreshold) continue;

    // Check daily budget limit
    const dealCost = (analysed.buyPrice || 0) * (analysed.u || 1);
    if (dealCost > ap.maxSpendPerDeal) { log(`🤖 Skip auto-order: ${deal.name.slice(0,30)} — £${dealCost.toFixed(0)} exceeds max £${ap.maxSpendPerDeal}/deal`); continue; }
    if (spentToday + dealCost > ap.dailyBudgetLimit) { log(`🤖 Daily limit reached (£${spentToday.toFixed(0)}/£${ap.dailyBudgetLimit})`); break; }

    // Auto-approve
    deal.autoApproved = true;
    deal.autoApprovedAt = new Date().toISOString();
    deal.status = 'approved';
    log(`🤖 Auto-approved: ${deal.name.slice(0,40)} — score ${analysed.score}, £${analysed.pr} profit, ${analysed.passedChecks}/${analysed.totalChecks}`);

    // Auto-order via CJ if available
    if (process.env.CJ_API_KEY && S.prepAddress) {
      try {
        const keyword = deal.name.split(' ').slice(0, 5).join(' ');
        const cjResults = await cjSearch(keyword, 3);
        if (cjResults?.length) {
          const cheapest = cjResults.reduce((a, b) => a.price < b.price ? a : b);
          deal.buyPrice = cheapest.price;
          deal.cjProduct = cheapest;
          deal.from = 'CJDropshipping';

          const orderResult = await cjOrder(cheapest.pid, analysed.u || 10, S.prepAddress);
          if (!orderResult.error) {
            // Move to inventory
            S.inventory = S.inventory || [];
            S.inventory.push({
              id: Date.now(), name: deal.name, units: analysed.u || 10,
              buyPrice: cheapest.price, sellPrice: deal.sellPrice, weightKg: deal.weightKg,
              dateSent: new Date().toISOString(), status: 'ordered', asin: deal.asin,
              category: deal.category, reviewCount: deal.reviewCount,
              from: 'CJDropshipping (autopilot)', cjOrderId: orderResult.data?.orderId,
              autoOrdered: true,
            });
            deal.status = 'ordered';
            S._autopilotSpend[todayKey] = (S._autopilotSpend[todayKey] || 0) + (cheapest.price * (analysed.u || 10));
            log(`🤖 Auto-ordered: ${deal.name.slice(0,30)} × ${analysed.u} units via CJ → prep centre`);
            actions++;
          } else {
            log(`🤖 CJ order failed: ${orderResult.error}`);
          }
        }
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) { log(`🤖 Auto-order error: ${e.message}`); }
    } else {
      // No CJ — just mark as approved, user orders manually
      S.inventory = S.inventory || [];
      S.inventory.push({
        id: Date.now(), name: deal.name, units: analysed.u || 10,
        buyPrice: deal.buyPrice, sellPrice: deal.sellPrice, weightKg: deal.weightKg,
        dateSent: new Date().toISOString(), status: 'ordered', asin: deal.asin,
        category: deal.category, reviewCount: deal.reviewCount,
        from: deal.from || 'Auto-approved', autoOrdered: false,
      });
      deal.status = 'ordered';
      actions++;
    }
  }

  // STEP 2: Auto-list on Amazon — items at prep that haven't been listed
  if (process.env.SP_REFRESH_TOKEN) {
    const atPrep = (S.inventory || []).filter(i => i.status === 'prep' && !i.amazonListed);
    for (const item of atPrep) {
      if (!item.asin) continue;
      try {
        const result = await spApiCreateOffer(item.asin, item.sellPrice * 0.97);
        if (result) {
          item.amazonListed = true;
          item.amazonSku = result.sku || `FBA-${item.asin}-${Date.now()}`;
          item.status = 'live';
          log(`🤖 Auto-listed: ${item.name.slice(0,30)} @ £${(item.sellPrice * 0.97).toFixed(2)} on Amazon`);
          actions++;
        }
      } catch (e) { log(`🤖 Auto-list error: ${e.message}`); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // STEP 3: Auto-sync sales from Amazon
  if (process.env.SP_REFRESH_TOKEN) {
    try {
      const orders = await spApiGetOrders(7);
      if (orders?.payload?.Orders) {
        for (const order of orders.payload.Orders) {
          if (order.OrderStatus !== 'Shipped' && order.OrderStatus !== 'Delivered') continue;
          const inv = (S.inventory || []).find(i => i.amazonSku);
          if (inv) {
            inv.sold = (inv.sold || 0) + 1;
            inv.revenue = (inv.revenue || 0) + parseFloat(order.OrderTotal?.Amount || inv.sellPrice);
          }
        }
      }
    } catch (e) { /* silent */ }
  }

  // Clean up old autopilot spend (keep 7 days)
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  Object.keys(S._autopilotSpend || {}).forEach(k => { if (k < cutoff) delete S._autopilotSpend[k]; });

  if (actions) save(S);
  log(`🤖 Autopilot done — ${actions} actions taken`);
}

// Weekly profit email digest (if Gmail configured)
async function sendDigest() {
  if (!S.autopilot?.enabled) return;
  const inv = S.inventory || [];
  const totalProfit = inv.reduce((a, i) => a + (i.revenue || 0) - (i.units || 0) * (i.buyPrice || 0), 0);
  const totalSold = inv.reduce((a, i) => a + (i.sold || 0), 0);
  const liveCount = inv.filter(i => i.status === 'live').length;
  const orderedCount = inv.filter(i => i.status === 'ordered').length;
  log(`📊 Weekly: ${totalSold} sold, £${totalProfit.toFixed(2)} profit, ${liveCount} live, ${orderedCount} ordered`);
}

// ═══════════════════════════════════════
// CRON
// ═══════════════════════════════════════
cron.schedule('*/2 * * * *', ()=>{ log('📧 Gmail check...'); checkGmail(); });
cron.schedule('0 */2 * * *', ()=>autoScan()); // Scan every 2 hours
cron.schedule('30 */2 * * *', ()=>runAutopilot()); // Autopilot every 2hr (30min after scan)
cron.schedule('0 9 * * 1', ()=>sendDigest()); // Weekly digest Monday 9am
cron.schedule('0 8 * * *', ()=>{
  log('📦 Inventory check...');
  (S.inventory||[]).forEach(i=>{
    const d=Math.floor((Date.now()-new Date(i.dateSent).getTime())/86400000);
    if(d>=240) log(`⚠️ "${i.name}" — ${d} days!`);
  });
});

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════
app.get('/api/state', (req,res)=>{
  const b = S.budget||200;
  const deals = (S.deals||[]).map(d=>analyse(d,b)).sort((a,b)=>b.score-a.score);
  const inv = (S.inventory||[]).map(i=>{
    const days=Math.floor((Date.now()-new Date(i.dateSent).getTime())/86400000);
    const cf=Math.max((i.weightKg||0.3)*0.5,0.1);
    const sold = i.sold || 0;
    const returnCount = i.returnCount || 0;
    const remaining = Math.max((i.units||0) - sold - returnCount, 0);
    const revenue = i.revenue || 0;
    const totalCostIn = (i.units||0) * (i.buyPrice||0);
    const realProfit = parseFloat((revenue - totalCostIn).toFixed(2));
    const realROI = totalCostIn > 0 ? parseFloat(((realProfit / totalCostIn) * 100).toFixed(0)) : 0;
    return {...i, days, surcharge:calcSurcharge(days,cf), sold, returnCount, remaining, revenue, totalCostIn, realProfit, realROI};
  });
  res.json({deals,inventory:inv,alerts:(S.alerts||[]).slice(0,50),lastGmailCheck:S.lastGmailCheck,budget:b,
    log:(S.log||[]).slice(0,30),keepa:!!process.env.KEEPA_API_KEY,gmail:!!process.env.GMAIL_CLIENT_ID,
    cj:!!process.env.CJ_API_KEY,spApi:!!process.env.SP_REFRESH_TOKEN,prepAddress:!!S.prepAddress,
    autopilot:S.autopilot,
    sources:SOURCES.map(s=>({name:s.name,region:s.region,ship:s.ship,days:s.days}))});
});

app.post('/api/budget', (req,res)=>{ S.budget=req.body.budget||200; save(S); res.json({ok:true}); });

// Autopilot settings
app.get('/api/autopilot', (req,res)=>{ res.json(S.autopilot); });
app.post('/api/autopilot', (req,res)=>{
  S.autopilot = { ...S.autopilot, ...req.body };
  save(S);
  log(`🤖 Autopilot ${S.autopilot.enabled ? 'ENABLED' : 'disabled'} — min score ${S.autopilot.minScore}, min profit £${S.autopilot.minProfit}, daily limit £${S.autopilot.dailyBudgetLimit}`);
  res.json({ ok: true, autopilot: S.autopilot });
});
app.post('/api/autopilot/run', async(req,res)=>{ await runAutopilot(); res.json({ ok: true }); });

// ═══════════════════════════════════════
// SIMULATION — inject realistic test data to demo the full pipeline
// ═══════════════════════════════════════
app.post('/api/simulate', (req,res)=>{
  const simDeals = [
    { name: 'Silicone Kitchen Utensil Set 12 Piece Heat Resistant Cooking Tools', asin: 'B0SIM00001',
      sellPrice: 24.99, buyPrice: 6.25, estBuyPrice: 6.25, weightKg: 0.8,
      category: 'Home & Kitchen', brand: 'HomeCraft', sellerCount: 8, amazonSells: false,
      priceStability: 85, priceMin90: '22.99', priceMax90: '26.99',
      reviewCount: 4200, rating: 4.3, salesRank: 1850, bsrDrops90d: 180, estimatedSales90d: 180,
      reviews: '4K+ · 4.3★' },
    { name: 'LED Night Light Motion Sensor Rechargeable Warm White 2 Pack', asin: 'B0SIM00002',
      sellPrice: 15.99, buyPrice: 3.50, estBuyPrice: 3.50, weightKg: 0.25,
      category: 'Lighting', brand: 'BrightHome', sellerCount: 5, amazonSells: false,
      priceStability: 90, priceMin90: '14.99', priceMax90: '16.99',
      reviewCount: 8900, rating: 4.5, salesRank: 920, bsrDrops90d: 310, estimatedSales90d: 310,
      reviews: '9K+ · 4.5★' },
    { name: 'Stainless Steel Dog Bowl Non-Slip Rubber Base Large 2 Pack', asin: 'B0SIM00003',
      sellPrice: 13.99, buyPrice: 3.20, estBuyPrice: 3.20, weightKg: 0.6,
      category: 'Pet Supplies', brand: 'PetPro', sellerCount: 6, amazonSells: false,
      priceStability: 88, priceMin90: '12.99', priceMax90: '14.99',
      reviewCount: 6100, rating: 4.4, salesRank: 2100, bsrDrops90d: 150, estimatedSales90d: 150,
      reviews: '6K+ · 4.4★' },
    { name: 'Bamboo Desk Organiser with Drawer Office Storage Tidy', asin: 'B0SIM00004',
      sellPrice: 19.99, buyPrice: 4.80, estBuyPrice: 4.80, weightKg: 0.9,
      category: 'Stationery & Office', brand: 'DeskTidy', sellerCount: 4, amazonSells: false,
      priceStability: 82, priceMin90: '18.99', priceMax90: '21.99',
      reviewCount: 3200, rating: 4.2, salesRank: 3400, bsrDrops90d: 95, estimatedSales90d: 95,
      reviews: '3K+ · 4.2★' },
    { name: 'Resistance Bands Set 5 Pack Exercise Fitness Yoga Pilates', asin: 'B0SIM00005',
      sellPrice: 11.99, buyPrice: 2.50, estBuyPrice: 2.50, weightKg: 0.2,
      category: 'Sports & Outdoors', brand: 'FitBands', sellerCount: 12, amazonSells: false,
      priceStability: 75, priceMin90: '9.99', priceMax90: '12.99',
      reviewCount: 15000, rating: 4.4, salesRank: 650, bsrDrops90d: 420, estimatedSales90d: 420,
      reviews: '15K+ · 4.4★' },
  ];

  S.deals = S.deals || [];
  const added = [];
  simDeals.forEach(sd => {
    if (S.deals.find(d => d.asin === sd.asin)) return;
    const deal = {
      ...sd, id: Date.now() + Math.random(),
      from: 'AliExpress (est.)', sources: getSources(sd.name),
      amzUrl: `https://www.amazon.co.uk/dp/${sd.asin}`,
      note: `Simulated deal. £${sd.sellPrice} on Amazon, buy ~£${sd.buyPrice} from China. BSR #${sd.salesRank}. ~${sd.estimatedSales90d} sales/90d.`,
      risks: ['This is simulated test data — not a real product'],
      src: 'Simulation', autoFound: true, needsPrice: false, status: 'found',
    };
    // Only add if it passes the quality bar
    const analysed = analyse(deal, S.budget || 200);
    if (analysed.pr > 0) {
      S.deals.unshift(deal);
      added.push({ name: sd.name, profit: analysed.pr, score: analysed.score, checks: `${analysed.passedChecks}/${analysed.totalChecks}` });
    }
  });

  // Also add simulated inventory items at different pipeline stages
  S.inventory = S.inventory || [];
  if (!S.inventory.find(i => i.asin === 'B0SIM10001')) {
    S.inventory.push({
      id: Date.now()+1, name: 'Collapsible Silicone Water Bottle 500ml BPA Free', asin: 'B0SIM10001',
      units: 40, buyPrice: 3.80, sellPrice: 16.99, weightKg: 0.3,
      category: 'Sports & Outdoors', reviewCount: 5200,
      dateSent: new Date(Date.now() - 5*86400000).toISOString(), status: 'ordered',
      from: 'AliExpress', sources: getSources('Collapsible Silicone Water Bottle'),
    });
  }
  if (!S.inventory.find(i => i.asin === 'B0SIM10002')) {
    S.inventory.push({
      id: Date.now()+2, name: 'Magnetic Phone Mount Car Dashboard Universal', asin: 'B0SIM10002',
      units: 55, buyPrice: 2.10, sellPrice: 12.99, weightKg: 0.15,
      category: 'DIY & Tools', reviewCount: 11000,
      dateSent: new Date(Date.now() - 12*86400000).toISOString(), status: 'prep',
      from: 'AliExpress', sources: getSources('Magnetic Phone Mount Car'),
    });
  }
  if (!S.inventory.find(i => i.asin === 'B0SIM10003')) {
    S.inventory.push({
      id: Date.now()+3, name: 'Bamboo Chopping Board Set 3 Pack Cutting Kitchen', asin: 'B0SIM10003',
      units: 30, buyPrice: 4.50, sellPrice: 18.99, weightKg: 1.2,
      category: 'Home & Kitchen', reviewCount: 7800,
      dateSent: new Date(Date.now() - 25*86400000).toISOString(), status: 'live',
      sold: 8, revenue: 151.92, returnCount: 1,
      from: 'Alibaba', sources: getSources('Bamboo Chopping Board Set'),
    });
  }

  save(S);
  log(`🧪 Simulation: added ${added.length} deals + 3 inventory items`);
  res.json({ ok: true, added, msg: `Added ${added.length} deals + inventory at ordered/prep/live stages` });
});

// Set buy price for a deal (user verified)
app.post('/api/deals/:id/price', (req,res)=>{
  S.deals = (S.deals||[]).map(d=> d.id==req.params.id ? {...d, buyPrice:req.body.buyPrice, from:req.body.from||d.from, buyUrl:req.body.buyUrl||d.buyUrl, needsPrice:false} : d);
  save(S);
  res.json({ok:true});
});

app.get('/api/lookup/:asin', async(req,res)=>{
  if (!/^[A-Z0-9]{10}$/.test(req.params.asin)) return res.status(400).json({error:'Invalid ASIN'});
  const k = await keepa(req.params.asin);
  if(!k) return res.json({error:'Not found'});
  const sp=parseFloat(k.price||k.buyBox||0);
  const salesEst=estimateSales(k.bsr,k.category);
  const demand=assessDemand(k.bsr||999999,k.reviewCount||0,parseFloat(k.rating||0),salesEst);
  res.json({...k,salesEst,demand,amazonPrice:sp,sources:getSources(k.title)});
});

app.post('/api/deals', (req,res)=>{
  S.deals=S.deals||[];
  const d={...req.body,id:Date.now(),sources:getSources(req.body.name||''),addedAt:new Date().toISOString()};
  S.deals.unshift(d); save(S); res.json({ok:true});
});
app.delete('/api/deals/:id', (req,res)=>{ S.deals=(S.deals||[]).filter(d=>d.id!=req.params.id); save(S); res.json({ok:true}); });

// Pipeline: found → priced → ordered → prep → live → selling
app.post('/api/deals/:id/status', (req,res)=>{
  S.deals = (S.deals||[]).map(d=> d.id==req.params.id ? {...d, status:req.body.status} : d);
  save(S); res.json({ok:true});
});

app.post('/api/approve/:index', (req,res)=>{
  const deal=(S.deals||[])[req.params.index];
  if(!deal) return res.status(404).json({error:'Not found'});
  if(!deal.buyPrice) return res.status(400).json({error:'Set buy price first'});
  const units = req.body.units||Math.floor((S.budget||200)/(deal.buyPrice||1));
  S.inventory=S.inventory||[];
  S.inventory.push({id:Date.now(),name:deal.name,units,
    buyPrice:deal.buyPrice,sellPrice:deal.sellPrice,weightKg:deal.weightKg,
    dateSent:new Date().toISOString(),status:'ordered',asin:deal.asin,
    category:deal.category,reviewCount:deal.reviewCount,from:deal.from,buyUrl:deal.buyUrl});
  // Update deal status
  deal.status = 'ordered';
  log(`📦 Ordered: ${deal.name} × ${units} units`);
  save(S); res.json({ok:true,units});
});

app.patch('/api/inventory/:id', (req,res)=>{ S.inventory=(S.inventory||[]).map(i=>i.id==req.params.id?{...i,...req.body}:i); save(S); res.json({ok:true}); });
app.delete('/api/inventory/:id', (req,res)=>{ S.inventory=(S.inventory||[]).filter(i=>i.id!=req.params.id); save(S); res.json({ok:true}); });

// Record a sale against inventory
app.post('/api/inventory/:id/sale', (req,res)=>{
  const {units, actualPrice} = req.body;
  S.inventory = (S.inventory||[]).map(i => {
    if (i.id != req.params.id) return i;
    const sales = i.sales || [];
    sales.push({ units: units||1, price: actualPrice||i.sellPrice, date: new Date().toISOString() });
    const totalSold = sales.reduce((a,s) => a + s.units, 0);
    const totalRevenue = sales.reduce((a,s) => a + (s.units * s.price), 0);
    return { ...i, sales, sold: totalSold, revenue: parseFloat(totalRevenue.toFixed(2)) };
  });
  save(S); res.json({ok:true});
});

// Record a return against inventory
app.post('/api/inventory/:id/return', (req,res)=>{
  const {units, reason} = req.body;
  S.inventory = (S.inventory||[]).map(i => {
    if (i.id != req.params.id) return i;
    const returns = i.returns || [];
    returns.push({ units: units||1, reason: reason||'', date: new Date().toISOString() });
    const totalReturns = returns.reduce((a,r) => a + r.units, 0);
    return { ...i, returns, returnCount: totalReturns };
  });
  save(S); res.json({ok:true});
});

app.post('/api/gmail/check', async(req,res)=>res.json(await checkGmail()));
app.post('/api/scan', async(req,res)=>{ autoScan(); res.json({msg:'Started'}); });

// ═══════════════════════════════════════
// QUICK ASIN SCAN (for iPhone in-store scanning)
// Paste/type an ASIN → get full deal analysis instantly
// ═══════════════════════════════════════
app.post('/api/quick-scan', async(req,res)=>{
  const asin = (req.body.asin||'').toUpperCase().trim();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return res.status(400).json({error:'Invalid ASIN format'});
  const buyPrice = req.body.buyPrice ? parseFloat(req.body.buyPrice) : null;
  const source = req.body.source || '';

  // Check if we already have this deal
  const existing = (S.deals||[]).find(d=>d.asin===asin);
  if (existing && !buyPrice) return res.json({existing: true, deal: analyse(existing, S.budget||200)});

  const k = await keepa(asin);
  if (!k || !k.price) return res.json({error:'Product not found on Amazon UK or no price data'});

  const sp = parseFloat(k.price);
  const deal = {
    id: Date.now()+Math.random(), name: k.title, asin, sellPrice: sp,
    buyPrice: buyPrice, weightKg: parseFloat(k.weight||0.3), category: k.category||'Home & Kitchen',
    brand: k.brand, sellerCount: k.sellerCount, amazonSells: k.amazonSells,
    priceStability: k.priceStability, priceMin90: k.priceMin90, priceMax90: k.priceMax90,
    reviewCount: k.reviewCount, rating: k.rating, salesRank: k.bsr,
    bsrDrops90d: k.bsrDrops90d, estimatedSales90d: k.estimatedSales90d,
    reviews: k.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
    from: source || 'Quick scan', sources: getSources(k.title),
    amzUrl: `https://www.amazon.co.uk/dp/${asin}`,
    note: `Quick scan. £${sp} Amazon. BSR #${k.bsr||'?'}.${k.sellerCount?' '+k.sellerCount+' sellers.':''}`,
    risks: buyPrice ? [] : ['Buy price not set — enter what you can buy it for'],
    src: `Quick scan (${new Date().toLocaleDateString('en-GB')})`,
    autoFound: false, needsPrice: !buyPrice,
  };

  // Auto-add to deals
  S.deals = S.deals||[];
  S.deals.unshift(deal);
  save(S);
  log(`🔍 Scanned: ${k.title} — £${sp} Amazon, BSR #${k.bsr}`);

  const result = analyse(deal, S.budget||200);
  res.json({deal: result, added: true});
});

// ═══════════════════════════════════════
// PRICE MONITOR — check if competitors undercut your inventory
// ═══════════════════════════════════════
async function checkPrices() {
  if (!process.env.KEEPA_API_KEY) return;
  const inv = S.inventory || [];
  const alerts = [];
  for (const item of inv) {
    if (!item.asin) continue;
    if (item.sold >= item.units) continue; // fully sold
    try {
      const k = await keepa(item.asin);
      if (!k || !k.price) continue;
      const currentPrice = parseFloat(k.price);
      const yourPrice = item.sellPrice || 0;
      const priceDiff = parseFloat(((yourPrice - currentPrice) / yourPrice * 100).toFixed(0));

      if (currentPrice < yourPrice * 0.95) {
        // Price dropped more than 5%
        const alert = `Price drop on "${item.name}": £${yourPrice.toFixed(2)} → £${currentPrice.toFixed(2)} (${priceDiff}%)`;
        log(`🔴 ${alert}`);
        alerts.push({ type: 'price_drop', item: item.name, asin: item.asin, was: yourPrice, now: currentPrice, diff: priceDiff });
        // Update the sell price
        item.currentAmazonPrice = currentPrice;
        item.priceAlert = alert;
      } else if (currentPrice > yourPrice * 1.05) {
        // Price went up — opportunity to raise yours
        const alert = `Price up on "${item.name}": £${yourPrice.toFixed(2)} → £${currentPrice.toFixed(2)} (+${Math.abs(priceDiff)}%)`;
        log(`🟢 ${alert}`);
        alerts.push({ type: 'price_up', item: item.name, asin: item.asin, was: yourPrice, now: currentPrice, diff: priceDiff });
        item.currentAmazonPrice = currentPrice;
        item.priceAlert = alert;
      } else {
        item.currentAmazonPrice = currentPrice;
        item.priceAlert = null;
      }
      await new Promise(r=>setTimeout(r,2000));
    } catch(e) { log('Price check error: '+e.message); }
  }
  if (alerts.length) save(S);
  return alerts;
}

// Run price check every 4 hours
cron.schedule('30 */4 * * *', ()=>{ log('💰 Price check...'); checkPrices(); });

app.post('/api/price-check', async(req,res)=>{ const a = await checkPrices(); res.json({alerts:a, msg:`${a.length} price changes found`}); });

// Quality check for a product
app.get('/api/quality/:asin', async(req,res)=>{
  if (!/^[A-Z0-9]{10}$/.test(req.params.asin)) return res.status(400).json({error:'Invalid ASIN'});
  const k = await keepa(req.params.asin);
  if(!k) return res.json({error:'Not found'});
  const quality = assessQuality({
    name: k.title, asin: k.asin, reviewCount: k.reviewCount,
    rating: k.rating, salesRank: k.bsr, category: k.category,
  });
  res.json({...k, quality});
});

// Auto-generate Amazon listing
app.post('/api/listing/generate', (req,res)=>{
  const d = req.body;
  const name = d.name || 'Product';
  const cat = d.category || 'Home & Kitchen';
  const price = d.sellPrice || 0;
  const words = name.split(' ');

  // Generate professional title (keyword-rich)
  const title = name.length > 60 ? name : `${name} - Premium Quality, UK Seller, Fast Delivery`;

  // Generate 5 bullet points
  const bullets = [
    `✅ PREMIUM QUALITY — High-grade materials built to last. Trusted by ${d.reviewCount ? (d.reviewCount/1000).toFixed(0)+'K+' : 'thousands of'} Amazon UK customers`,
    `✅ EASY TO USE — Simple, intuitive design. Perfect for beginners and professionals alike. Ready to use straight out of the box`,
    `✅ FAST UK DELIVERY — Fulfilled by Amazon (FBA) with Prime delivery. Order today, receive tomorrow`,
    `✅ GREAT VALUE — Premium quality at an affordable price. Compare with leading brands and save`,
    `✅ SATISFACTION GUARANTEED — Backed by Amazon's returns policy. Buy with confidence`,
  ];

  // Generate description
  const description = `Discover the ${name} — trusted by thousands of Amazon UK customers.

This premium ${cat.toLowerCase()} product delivers outstanding performance at an unbeatable price. Whether you're a first-time buyer or upgrading from another brand, you'll appreciate the quality materials, thoughtful design, and reliable performance.

Why Choose This Product?
Our ${words.slice(0,3).join(' ')} stands out from the competition with superior build quality, easy-to-use features, and excellent value for money. With ${d.reviewCount ? (d.reviewCount/1000).toFixed(0)+'K+' : 'thousands of'} positive reviews, you can buy with confidence.

What's in the Box:
1x ${name}
User manual included
All accessories included

Fulfilled by Amazon — enjoy fast, reliable Prime delivery and easy returns.`;

  // Generate keywords
  const keywords = words.filter(w => w.length > 3).join(', ') + ', ' + cat.toLowerCase().replace(/[&>]/g, ',');

  // Optimal price suggestion
  const optimalPrice = price; // Use current Amazon price to match Buy Box

  res.json({
    title: title.slice(0, 200),
    bullets,
    description,
    keywords: keywords.slice(0, 500),
    optimalPrice,
    copyPasteReady: `TITLE:\n${title}\n\nBULLET POINTS:\n${bullets.join('\n')}\n\nDESCRIPTION:\n${description}\n\nKEYWORDS:\n${keywords}`,
  });
});

// Tax summary
app.get('/api/tax-summary', (req,res)=>{
  const inv = S.inventory || [];
  let totalRevenue = 0, totalCost = 0, totalProfit = 0;
  inv.forEach(i => {
    const sold = i.sold || 0;
    totalRevenue += sold * (i.sellPrice || 0);
    totalCost += i.units * (i.buyPrice || 0);
    totalProfit += sold * ((i.sellPrice || 0) - (i.buyPrice || 0));
  });
  const toolCosts = 96 * 12; // Annual tool cost estimate
  const taxableProfit = Math.max(totalProfit - toolCosts, 0);
  const personalAllowance = 12570;
  const taxableAfterAllowance = Math.max(taxableProfit - personalAllowance, 0);
  const incomeTax = taxableAfterAllowance * 0.20;
  const ni = taxableProfit > 12570 ? (taxableProfit - 12570) * 0.09 : 0;
  const vatThreshold = 85000;
  const vatWarning = totalRevenue > vatThreshold * 0.8;

  res.json({
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    totalCost: parseFloat(totalCost.toFixed(2)),
    totalProfit: parseFloat(totalProfit.toFixed(2)),
    toolCosts,
    taxableProfit: parseFloat(taxableProfit.toFixed(2)),
    incomeTax: parseFloat(incomeTax.toFixed(2)),
    nationalInsurance: parseFloat(ni.toFixed(2)),
    totalTax: parseFloat((incomeTax + ni).toFixed(2)),
    netAfterTax: parseFloat((totalProfit - incomeTax - ni).toFixed(2)),
    setAsideMonthly: parseFloat(((incomeTax + ni) / 12).toFixed(2)),
    vatThreshold,
    vatWarning,
    vatMessage: vatWarning ? '⚠️ Approaching VAT threshold (£85K) — register soon!' : '✅ Below VAT threshold',
  });
});

app.post('/api/fees', (req,res)=>{
  const {sellPrice,weightKg,category,buyPrice,bubbleWrap}=req.body;
  const a=calcFees(sellPrice||0,weightKg||0.3,category||'Home & Kitchen');
  const p=calcPrep(bubbleWrap||false);
  const tc=parseFloat(((buyPrice||0)+p.t+a.rf+a.ff+a.sf).toFixed(2));
  const pr=parseFloat(((sellPrice||0)-tc).toFixed(2));
  const salesEst=estimateSales(req.body.bsr,category);
  res.json({amazon:a,prep:p,totalCost:tc,profit:pr,margin:sellPrice>0?((pr/sellPrice)*100).toFixed(1):0,salesEst});
});

// ═══════════════════════════════════════
// CJ DROPSHIPPING ROUTES — Real China prices
// ═══════════════════════════════════════
app.post('/api/cj/search', async(req,res)=>{
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  const results = await cjSearch(keyword);
  if (!results) return res.json({ error: 'CJ API not configured or no results', setup: !process.env.CJ_API_KEY });
  res.json({ results });
});

// Get real China price for a deal and update it
app.post('/api/deals/:id/cj-price', async(req,res)=>{
  const deal = (S.deals||[]).find(d => d.id == req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const keyword = (deal.name || '').split(' ').slice(0, 5).join(' ');
  const results = await cjSearch(keyword, 3);
  if (!results?.length) return res.json({ error: 'No CJ results found', keyword });

  // Pick cheapest result
  const cheapest = results.reduce((a, b) => a.price < b.price ? a : b);
  deal.buyPrice = cheapest.price;
  deal.cjProduct = cheapest;
  deal.from = 'CJDropshipping';
  deal.buyUrl = cheapest.url;
  deal.needsPrice = false;
  save(S);
  log(`💰 CJ price: ${deal.name.slice(0,40)} → £${cheapest.price} (was est. £${deal.estBuyPrice})`);
  res.json({ ok: true, price: cheapest.price, product: cheapest });
});

// Order via CJ Dropshipping (ships to your prep centre)
app.post('/api/cj/order', async(req,res)=>{
  const { dealId, quantity } = req.body;
  const deal = (S.deals||[]).find(d => d.id == dealId);
  if (!deal?.cjProduct) return res.status(400).json({ error: 'No CJ product linked — run CJ price check first' });
  if (!S.prepAddress) return res.status(400).json({ error: 'Set your prep centre address first in Setup' });

  const result = await cjOrder(deal.cjProduct.pid, quantity || deal.u || 10, S.prepAddress);
  if (result.error) return res.json({ error: result.error });

  // Move to inventory as ordered
  S.inventory = S.inventory || [];
  S.inventory.push({
    id: Date.now(), name: deal.name, units: quantity || deal.u || 10,
    buyPrice: deal.buyPrice, sellPrice: deal.sellPrice, weightKg: deal.weightKg,
    dateSent: new Date().toISOString(), status: 'ordered', asin: deal.asin,
    category: deal.category, reviewCount: deal.reviewCount,
    from: 'CJDropshipping', cjOrderId: result.data?.orderId,
  });
  deal.status = 'ordered';
  save(S);
  log(`📦 CJ Order placed: ${deal.name.slice(0,40)} × ${quantity || deal.u} units`);
  res.json({ ok: true, orderId: result.data?.orderId });
});

// ═══════════════════════════════════════
// AMAZON SP-API ROUTES — Auto-list & track sales
// ═══════════════════════════════════════
app.post('/api/amazon/list', async(req,res)=>{
  const { inventoryId } = req.body;
  const item = (S.inventory||[]).find(i => i.id == inventoryId);
  if (!item?.asin) return res.status(400).json({ error: 'No ASIN on inventory item' });
  if (!process.env.SP_REFRESH_TOKEN) return res.json({ error: 'Amazon SP-API not configured', setup: true });

  const result = await spApiCreateOffer(item.asin, item.sellPrice * 0.97); // 3% under for Buy Box
  if (!result) return res.json({ error: 'SP-API call failed' });
  item.amazonListed = true;
  item.amazonSku = result.sku || `FBA-${item.asin}-${Date.now()}`;
  item.status = 'live';
  save(S);
  log(`🏪 Listed on Amazon: ${item.name.slice(0,40)} @ £${(item.sellPrice * 0.97).toFixed(2)}`);
  res.json({ ok: true, result });
});

// Sync sales from Amazon SP-API
app.post('/api/amazon/sync-sales', async(req,res)=>{
  if (!process.env.SP_REFRESH_TOKEN) return res.json({ error: 'Amazon SP-API not configured', setup: true });
  const orders = await spApiGetOrders(30);
  if (!orders?.payload?.Orders) return res.json({ error: 'No orders data', raw: orders });

  let synced = 0;
  for (const order of orders.payload.Orders) {
    if (order.OrderStatus !== 'Shipped' && order.OrderStatus !== 'Delivered') continue;
    // Match orders to inventory by ASIN
    const inv = (S.inventory||[]).find(i => i.amazonSku && order.OrderItems?.some(oi => oi.SellerSKU === i.amazonSku));
    if (inv) {
      inv.sold = (inv.sold || 0) + 1;
      inv.revenue = (inv.revenue || 0) + parseFloat(order.OrderTotal?.Amount || inv.sellPrice);
      synced++;
    }
  }
  if (synced) save(S);
  log(`📊 Amazon sync: ${synced} orders matched`);
  res.json({ ok: true, synced, totalOrders: orders.payload.Orders.length });
});

// Get live inventory from Amazon
app.post('/api/amazon/sync-inventory', async(req,res)=>{
  if (!process.env.SP_REFRESH_TOKEN) return res.json({ error: 'Amazon SP-API not configured', setup: true });
  const inv = await spApiGetInventory();
  if (!inv?.payload?.inventorySummaries) return res.json({ error: 'No inventory data' });
  // Update local inventory with Amazon's live counts
  let updated = 0;
  for (const amzItem of inv.payload.inventorySummaries) {
    const local = (S.inventory||[]).find(i => i.asin === amzItem.asin);
    if (local) {
      local.amazonStock = amzItem.totalQuantity;
      local.amazonInbound = amzItem.inboundWorkingQuantity || 0;
      updated++;
    }
  }
  if (updated) save(S);
  res.json({ ok: true, updated });
});

// ═══════════════════════════════════════
// TACTICAL ARBITRAGE ROUTES
// ═══════════════════════════════════════

// Upload TA CSV export — imports all profitable deals at once
app.post('/api/ta/import-csv', express.text({ type: '*/*', limit: '5mb' }), async(req,res)=>{
  const csvText = req.body;
  if (!csvText || typeof csvText !== 'string') return res.status(400).json({ error: 'Send CSV text in body' });

  const taDeals = parseTACSV(csvText);
  if (!taDeals.length) return res.json({ error: 'No valid deals found in CSV', hint: 'CSV must have ASIN, buy price, sell price columns' });

  let added = 0, skipped = 0;
  for (const td of taDeals) {
    // Skip duplicates
    if ((S.deals||[]).find(d => d.asin === td.asin)) { skipped++; continue; }

    // Enrich with Keepa if available
    let k = null;
    if (process.env.KEEPA_API_KEY) {
      k = await keepa(td.asin);
      await new Promise(r => setTimeout(r, 1500));
    }

    const deal = {
      id: Date.now() + Math.random(),
      name: k?.title || td.name,
      asin: td.asin,
      sellPrice: k?.price ? parseFloat(k.price) : td.sellPrice,
      buyPrice: td.buyPrice,
      estBuyPrice: td.buyPrice,
      weightKg: k?.weight ? parseFloat(k.weight) : 0.3,
      category: k?.category || td.category,
      brand: k?.brand || '',
      sellerCount: k?.sellerCount || null,
      amazonSells: k?.amazonSells || false,
      priceStability: k?.priceStability || null,
      priceMin90: k?.priceMin90 || null,
      priceMax90: k?.priceMax90 || null,
      reviewCount: k?.reviewCount || 0,
      rating: k?.rating || 0,
      salesRank: k?.bsr || td.bsr || 0,
      bsrDrops90d: k?.bsrDrops90d || 0,
      estimatedSales90d: k?.estimatedSales90d || 0,
      reviews: k?.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
      from: td.source || 'Tactical Arbitrage',
      buyUrl: td.sourceUrl || '',
      sources: getSources(k?.title || td.name),
      amzUrl: `https://www.amazon.co.uk/dp/${td.asin}`,
      note: `TA import. Buy £${td.buyPrice} from ${td.source||'TA source'} → Sell £${td.sellPrice} on Amazon.${td.roi ? ' TA ROI: '+td.roi+'%.' : ''}${td.bsr ? ' BSR #'+td.bsr+'.' : ''} VERIFIED price from TA scan.`,
      risks: ['Check product matches Amazon listing exactly'],
      src: `Tactical Arbitrage CSV (${new Date().toLocaleDateString('en-GB')})`,
      autoFound: true, needsPrice: false, fromTA: true, taVerified: true,
      status: 'found',
    };

    // Pre-analyse
    const analysed = analyse(deal, S.budget || 200);
    if (analysed.pr > 0 && analysed.score >= 40) {
      S.deals = S.deals || [];
      S.deals.unshift(deal);
      added++;
      log(`✅ TA CSV: ${(k?.title||td.name).slice(0,40)} — £${analysed.pr} profit, score ${analysed.score}`);
    } else {
      skipped++;
    }
  }

  save(S);
  log(`📊 TA CSV import: ${added} added, ${skipped} skipped from ${taDeals.length} rows`);
  res.json({ ok: true, added, skipped, total: taDeals.length });
});

// Webhook endpoint — TA can POST deal data here (if using Zapier/Make.com integration)
app.post('/api/ta/webhook', async(req,res)=>{
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'No data' });

  // Accept either single deal or array
  const items = Array.isArray(data) ? data : [data];
  let added = 0;

  for (const item of items) {
    const asin = item.asin || item.ASIN || '';
    if (!/^B0[A-Z0-9]{8}$/.test(asin)) continue;
    if ((S.deals||[]).find(d => d.asin === asin)) continue;

    const buyPrice = parseFloat(item.buyPrice || item.buy_price || item.cost || item.source_price || 0);
    const sellPrice = parseFloat(item.sellPrice || item.sell_price || item.amazon_price || 0);
    if (!buyPrice || !sellPrice) continue;

    // Enrich with Keepa
    let k = null;
    if (process.env.KEEPA_API_KEY) {
      k = await keepa(asin);
      await new Promise(r => setTimeout(r, 1500));
    }

    const deal = {
      id: Date.now() + Math.random(),
      name: k?.title || item.title || item.name || 'TA Deal',
      asin, sellPrice: k?.price ? parseFloat(k.price) : sellPrice,
      buyPrice, estBuyPrice: buyPrice,
      weightKg: k?.weight ? parseFloat(k.weight) : 0.3,
      category: k?.category || item.category || 'Home & Kitchen',
      brand: k?.brand || '', sellerCount: k?.sellerCount || null,
      amazonSells: k?.amazonSells || false,
      reviewCount: k?.reviewCount || 0, rating: k?.rating || 0,
      salesRank: k?.bsr || parseInt(item.bsr || item.sales_rank || 0),
      bsrDrops90d: k?.bsrDrops90d || 0, estimatedSales90d: k?.estimatedSales90d || 0,
      reviews: k?.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
      from: item.source || item.store || 'Tactical Arbitrage',
      buyUrl: item.source_url || item.buy_url || '',
      sources: getSources(k?.title || item.title || ''),
      amzUrl: `https://www.amazon.co.uk/dp/${asin}`,
      note: `TA webhook. Buy £${buyPrice} → Sell £${sellPrice}. VERIFIED.`,
      src: `TA Webhook (${new Date().toLocaleDateString('en-GB')})`,
      autoFound: true, needsPrice: false, fromTA: true, taVerified: true, status: 'found',
    };

    const analysed = analyse(deal, S.budget || 200);
    if (analysed.pr > 0) {
      S.deals = S.deals || [];
      S.deals.unshift(deal);
      added++;
      log(`✅ TA webhook: ${deal.name.slice(0,40)} — £${analysed.pr} profit, score ${analysed.score}`);
    }
  }

  if (added) save(S);
  res.json({ ok: true, added, received: items.length });
});

// Save prep centre address
app.post('/api/prep-address', (req,res)=>{
  S.prepAddress = req.body;
  save(S);
  res.json({ ok: true });
});

// Auto-sync Amazon sales every 6 hours
cron.schedule('0 */6 * * *', async()=>{
  if (!process.env.SP_REFRESH_TOKEN) return;
  log('📊 Auto-syncing Amazon sales...');
  try {
    const orders = await spApiGetOrders(7);
    if (orders?.payload?.Orders) {
      let synced = 0;
      for (const order of orders.payload.Orders) {
        const inv = (S.inventory||[]).find(i => i.amazonSku);
        if (inv && (order.OrderStatus === 'Shipped' || order.OrderStatus === 'Delivered')) {
          synced++;
        }
      }
      log(`📊 Auto-sync: ${synced} orders found`);
    }
  } catch(e) { log('Auto-sync error: '+e.message); }
});

// Auto-fetch CJ prices for new deals every scan
cron.schedule('15 */2 * * *', async()=>{
  if (!process.env.CJ_API_KEY) return;
  log('💰 Auto-fetching CJ prices...');
  const deals = (S.deals||[]).filter(d => !d.cjProduct && d.estBuyPrice);
  for (const deal of deals.slice(0, 5)) {
    const keyword = (deal.name || '').split(' ').slice(0, 5).join(' ');
    const results = await cjSearch(keyword, 3);
    if (results?.length) {
      const cheapest = results.reduce((a, b) => a.price < b.price ? a : b);
      deal.buyPrice = cheapest.price;
      deal.cjProduct = cheapest;
      deal.from = 'CJDropshipping';
      deal.buyUrl = cheapest.url;
      log(`💰 CJ auto-price: ${deal.name.slice(0,30)} → £${cheapest.price}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  save(S);
});

app.post('/api/seed', (req,res)=>{
  if(S.deals?.length>0) return res.json({msg:'Already seeded'});
  S.deals=[
    {id:1,name:"Digital Instant Read Meat Thermometer",reviews:"41K+ · 4.6★",category:"Home & Kitchen",buyPrice:3.80,sellPrice:12.99,weightKg:0.12,salesRank:47,reviewCount:41000,rating:"4.6",bsrDrops90d:2700,estimatedSales90d:2700,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-instant-read-meat-thermometer.html",amzUrl:"https://www.amazon.co.uk/s?k=instant+read+meat+thermometer",note:"Top 5 Amazon UK Kitchen. 2,700+ est. sales in 90 days.",risks:["ThermoPro dominates","10-20 day delivery"],src:"Research 30 Mar 2026",sources:getSources("instant read meat thermometer")},
    {id:2,name:"Glass Olive Oil Sprayer 470ml",reviews:"38K+ · 4.4★",category:"Home & Kitchen",buyPrice:2.50,sellPrice:9.99,weightKg:0.35,bubbleWrap:true,salesRank:112,reviewCount:38000,rating:"4.4",bsrDrops90d:2200,estimatedSales90d:2200,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-olive-oil-sprayer-glass.html",amzUrl:"https://www.amazon.co.uk/s?k=olive+oil+sprayer+glass",note:"Air fryer trend. 2,200+ est. sales in 90 days.",risks:["Glass fragile","Low per-unit profit"],src:"Research 30 Mar 2026",sources:getSources("olive oil sprayer glass")},
    {id:3,name:"8-Blade Vegetable Chopper",reviews:"124K+ · 4.5★",category:"Home & Kitchen",buyPrice:9.50,sellPrice:19.99,weightKg:0.80,salesRank:23,reviewCount:124500,rating:"4.5",bsrDrops90d:3500,estimatedSales90d:3500,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-vegetable-chopper-8-blade.html",amzUrl:"https://www.amazon.co.uk/s?k=vegetable+chopper+8+blade",note:"#1 kitchen gadget. 3,500+ est. sales in 90 days.",risks:["Fullstar dominates","Higher buy-in"],src:"Research 30 Mar 2026",sources:getSources("vegetable chopper 8 blade")},
  ];
  save(S); res.json({msg:'Seeded',count:3});
});

app.get('/api/health', (req,res)=>res.json({
  status:'running',uptime:Math.round(process.uptime()),keepa:!!process.env.KEEPA_API_KEY,gmail:!!process.env.GMAIL_CLIENT_ID,
  deals:(S.deals||[]).length,inventory:(S.inventory||[]).length,alerts:(S.alerts||[]).length,
  schedule:{gmail:'Every 2 min',scan:'Every 6 hours',inventory:'Daily 8am'},sources:SOURCES.length,
}));

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>{
  console.log(`\n🧠 FBA Brain v6.0 — http://localhost:${PORT}`);
  console.log(`   Keepa: ${process.env.KEEPA_API_KEY?'✅':'❌'}  CJ: ${process.env.CJ_API_KEY?'✅':'❌'}  Amazon SP: ${process.env.SP_REFRESH_TOKEN?'✅':'❌'}  Gmail: ${process.env.GMAIL_CLIENT_ID?'✅':'—'}`);
  console.log(`   🔍 Auto-scan: ${SCAN_CATEGORIES.length} categories / 2hr`);
  console.log(`   💰 CJ auto-price: every 2hr (15min offset)`);
  console.log(`   📊 Amazon sales sync: every 6hr`);
  console.log(`   💰 Price monitor: every 4hr`);
  console.log(`   🌍 ${SOURCES.length} sources · 8-point checks · competition analysis\n`);
  if(!S.deals?.length) { S.deals=[
    {id:1,name:"Digital Instant Read Meat Thermometer",reviews:"41K+ · 4.6★",category:"Home & Kitchen",buyPrice:3.80,sellPrice:12.99,weightKg:0.12,salesRank:47,reviewCount:41000,rating:"4.6",bsrDrops90d:2700,estimatedSales90d:2700,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-instant-read-meat-thermometer.html",amzUrl:"https://www.amazon.co.uk/s?k=instant+read+meat+thermometer",note:"Top 5 Amazon UK Kitchen. 2,700+ est. sales in 90 days.",risks:["ThermoPro dominates","10-20 day delivery"],src:"Research 30 Mar 2026",sources:getSources("instant read meat thermometer")},
    {id:2,name:"Glass Olive Oil Sprayer 470ml",reviews:"38K+ · 4.4★",category:"Home & Kitchen",buyPrice:2.50,sellPrice:9.99,weightKg:0.35,bubbleWrap:true,salesRank:112,reviewCount:38000,rating:"4.4",bsrDrops90d:2200,estimatedSales90d:2200,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-olive-oil-sprayer-glass.html",amzUrl:"https://www.amazon.co.uk/s?k=olive+oil+sprayer+glass",note:"Air fryer trend. 2,200+ est. sales in 90 days.",risks:["Glass fragile","Low per-unit profit"],src:"Research 30 Mar 2026",sources:getSources("olive oil sprayer glass")},
    {id:3,name:"8-Blade Vegetable Chopper",reviews:"124K+ · 4.5★",category:"Home & Kitchen",buyPrice:9.50,sellPrice:19.99,weightKg:0.80,salesRank:23,reviewCount:124500,rating:"4.5",bsrDrops90d:3500,estimatedSales90d:3500,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-vegetable-chopper-8-blade.html",amzUrl:"https://www.amazon.co.uk/s?k=vegetable+chopper+8+blade",note:"#1 kitchen gadget. 3,500+ est. sales in 90 days.",risks:["Fullstar dominates","Higher buy-in"],src:"Research 30 Mar 2026",sources:getSources("vegetable chopper 8 blade")},
  ]; save(S); log('Seeded 3 starter deals'); }
});
