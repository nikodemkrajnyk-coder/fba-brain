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
function detectPrivateLabel(sellerCount, brandName) {
  // If only 1 seller, likely private label — can't arbitrage
  if (sellerCount && sellerCount <= 1) {
    return { isPrivateLabel: true, message: '❌ Only 1 seller — likely private label/trademarked. Cannot arbitrage.' };
  }
  // Known big brands that block resellers
  const blockedBrands = ['apple','nike','adidas','samsung','sony','dyson','bose','lego','disney','nintendo','philips'];
  if (brandName && blockedBrands.some(b => brandName.toLowerCase().includes(b))) {
    return { isPrivateLabel: true, message: `❌ ${brandName} is a restricted brand — likely gated on Amazon` };
  }
  return { isPrivateLabel: false, message: '✅ Multiple sellers — open for arbitrage' };
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
  const privateLabel = detectPrivateLabel(d.sellerCount, d.brand);
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
  const bp=d.buyPrice||0, sp=d.sellPrice||0, wt=d.weightKg||0.3, cat=d.category||'Home & Kitchen';
  const amz=calcFees(sp,wt,cat), prep=calcPrep(d.bubbleWrap||d.fragile||false);
  const tc=parseFloat((bp+prep.t+amz.rf+amz.ff+amz.sf).toFixed(2));
  const pr=parseFloat((sp-tc).toFixed(2));
  const mg=sp>0?parseFloat(((pr/sp)*100).toFixed(1)):0;
  const u=bp>0?Math.floor(budget/bp):0;
  const bpr=parseFloat((u*pr).toFixed(2));
  const roi=bp>0?parseFloat(((pr/bp)*100).toFixed(0)):0;

  // Demand assessment
  const salesEst = estimateSales(d.salesRank || d.bsr, cat);
  const demand = assessDemand(d.salesRank || d.bsr || 999999, d.reviewCount || 0, parseFloat(d.rating || 0), salesEst);

  // Quality verification
  const quality = assessQuality(d);

  // Return rate impact on profit
  const returnRate = quality.returnRate.rate / 100;
  const returnImpact = parseFloat((pr * returnRate).toFixed(2));
  const adjustedProfit = parseFloat((pr - returnImpact).toFixed(2));
  const adjustedBatchProfit = parseFloat((u * adjustedProfit).toFixed(2));

  // Tax calculations (UK self-employed)
  const incomeTax = parseFloat((adjustedBatchProfit * 0.20).toFixed(2));
  const nationalInsurance = parseFloat((adjustedBatchProfit * 0.09).toFixed(2));
  const netAfterTax = parseFloat((adjustedBatchProfit - incomeTax - nationalInsurance).toFixed(2));

  // Combined score: profit (30%) + demand (35%) + quality (35%)
  const profitScore = Math.min(Math.round(Math.min(mg*1.2,40)+Math.min(roi*0.2,30)+(pr>3?20:pr>1?10:0)+10),100);
  const combinedScore = Math.round(profitScore * 0.30 + demand.score * 0.35 + quality.qualityScore * 0.35);

  // Time to sell estimate
  const timeToSell = salesEst.monthly > 0 ? Math.ceil(u / salesEst.monthly) : 99;

  // Reinvestment projection
  const reinvestment = [];
  let runningBudget = budget;
  for (let m = 1; m <= 6; m++) {
    const mUnits = Math.floor(runningBudget / (bp || 1));
    const mProfit = mUnits * adjustedProfit;
    const mTax = mProfit * 0.29;
    const mNet = mProfit - mTax;
    runningBudget += mNet;
    reinvestment.push({ month: m, units: mUnits, profit: parseFloat(mProfit.toFixed(2)), net: parseFloat(mNet.toFixed(2)), total: parseFloat(runningBudget.toFixed(2)) });
  }

  // Final recommendation — must pass ALL checks
  let rec;
  let passedChecks = 0;
  const totalChecks = 6;
  if (pr > 0) passedChecks++;
  if (demand.level !== 'skip') passedChecks++;
  if (quality.qualityLevel !== 'risky') passedChecks++;
  if (!quality.privateLabel.isPrivateLabel) passedChecks++;
  if (quality.season.peak) passedChecks++;
  if (quality.returnRate.rate <= 10) passedChecks++;

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
    demand, salesEst, timeToSell, profitScore, demandScore: demand.score,
    quality, returnImpact, adjustedProfit, adjustedBatchProfit,
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

    return {
      asin: p.asin, title: p.title,
      price: st.current?.[0]>0 ? (st.current[0]/100).toFixed(2) : null,
      avg90: st.avg90?.[0]>0 ? (st.avg90[0]/100).toFixed(2) : null,
      bsr: st.current?.[3] || null,
      reviewCount: p.csv?.[16] ? p.csv[16][p.csv[16].length-1] : null,
      rating: p.csv?.[17] ? (p.csv[17][p.csv[17].length-1]/10).toFixed(1) : null,
      category: p.categoryTree ? p.categoryTree.map(c=>c.name).join(' > ') : null,
      weight: p.packageWeight ? (p.packageWeight/1000).toFixed(2) : null,
      buyBox: st.current?.[18]>0 ? (st.current[18]/100).toFixed(2) : null,
      bsrDrops90d: bsrDrops,
      confirmedSales90d: bsrDrops, // minimum confirmed sales
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

      // Auto-extract ASINs and look up
      const asins = [...new Set(((alert.snippet+' '+alert.subject).match(/\bB0[A-Z0-9]{8}\b/g)||[]))];
      if (asins.length > 0 && process.env.KEEPA_API_KEY) {
        for (const asin of asins.slice(0,3)) {
          const k = await keepa(asin);
          if (k?.price) {
            const sp = parseFloat(k.price);
            const deal = {
              id: Date.now()+Math.random(), name: k.title, asin, sellPrice: sp,
              buyPrice: null, // MUST be verified — no guessing
              weightKg: parseFloat(k.weight||0.3), category: k.category||'Home & Kitchen',
              reviewCount: k.reviewCount, rating: k.rating, salesRank: k.bsr,
              bsrDrops90d: k.bsrDrops90d, confirmedSales90d: k.confirmedSales90d,
              reviews: k.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
              from: 'Find cheapest source below', sources: getSources(k.title),
              amzUrl: `https://www.amazon.co.uk/dp/${asin}`,
              note: `From Tactical Arbitrage alert. Amazon price: £${sp}. BSR: ${k.bsr}. ${k.confirmedSales90d}+ confirmed sales in 90 days. BUY PRICE NEEDS VERIFICATION — check all source links.`,
              risks: ['Buy price not yet verified — check sources', 'Compare all 11 sources for cheapest'],
              src: `Gmail alert → Keepa API (${new Date().toLocaleDateString('en-GB')})`,
              autoFound: true, needsPrice: true,
            };

            // Only add if demand is proven
            const salesEst = estimateSales(k.bsr, k.category);
            const demand = assessDemand(k.bsr||999999, k.reviewCount||0, parseFloat(k.rating||0), salesEst);
            if (demand.level !== 'skip') {
              S.deals = S.deals || [];
              S.deals.unshift(deal);
              log(`✅ Found: ${k.title} — BSR #${k.bsr}, ${k.confirmedSales90d}+ sales/90d, £${sp} Amazon`);
            } else {
              log(`❌ Skipped: ${k.title} — low demand (BSR ${k.bsr})`);
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
// AUTO SCANNER (every 6 hours)
// ═══════════════════════════════════════
async function autoScan() {
  if (!process.env.KEEPA_API_KEY) return;
  log('🔍 Auto-scanning Amazon UK best sellers...');
  const cats = [11052591, 560800, 364301031, 319530011, 77028031]; // Home, Kitchen, Pet, Sports, Baby
  for (const catId of cats) {
    try {
      const asins = await keepaBestSellers(catId);
      if (!asins?.length) continue;
      for (const asin of asins.slice(0,5)) {
        if ((S.deals||[]).find(d=>d.asin===asin)) continue;
        const k = await keepa(asin);
        if (!k?.price) continue;
        const sp = parseFloat(k.price);
        if (sp < 5 || sp > 50) continue;

        const salesEst = estimateSales(k.bsr, k.category);
        const demand = assessDemand(k.bsr||999999, k.reviewCount||0, parseFloat(k.rating||0), salesEst);
        if (demand.level === 'skip') continue;
        if (demand.score < 50) continue; // Only high-demand products

        const deal = {
          id: Date.now()+Math.random(), name: k.title, asin, sellPrice: sp,
          buyPrice: null, weightKg: parseFloat(k.weight||0.3), category: k.category||'Home & Kitchen',
          reviewCount: k.reviewCount, rating: k.rating, salesRank: k.bsr,
          bsrDrops90d: k.bsrDrops90d, confirmedSales90d: k.confirmedSales90d,
          reviews: k.reviewCount ? `${(k.reviewCount/1000).toFixed(0)}K+ · ${k.rating}★` : null,
          from: 'Find cheapest source', sources: getSources(k.title),
          amzUrl: `https://www.amazon.co.uk/dp/${asin}`,
          note: `Auto-found best seller. £${sp} on Amazon. BSR #${k.bsr}. ${k.confirmedSales90d}+ confirmed sales in 90 days.`,
          risks: ['Buy price needs verification'],
          src: `Auto-scan (${new Date().toLocaleDateString('en-GB')})`,
          autoFound: true, needsPrice: true,
        };
        S.deals = S.deals||[];
        S.deals.unshift(deal);
        log(`✅ Auto: ${k.title} — BSR #${k.bsr}, demand score ${demand.score}`);
        await new Promise(r=>setTimeout(r,2000));
      }
    } catch(e) { log('Scan error: '+e.message); }
  }
  save(S);
  log('🔍 Scan complete');
}

// ═══════════════════════════════════════
// CRON
// ═══════════════════════════════════════
cron.schedule('*/2 * * * *', ()=>{ log('📧 Gmail check...'); checkGmail(); });
cron.schedule('0 */6 * * *', ()=>autoScan());
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
    return {...i,days,surcharge:calcSurcharge(days,cf)};
  });
  res.json({deals,inventory:inv,alerts:(S.alerts||[]).slice(0,50),lastGmailCheck:S.lastGmailCheck,budget:b,
    log:(S.log||[]).slice(0,30),keepa:!!process.env.KEEPA_API_KEY,gmail:!!process.env.GMAIL_CLIENT_ID,
    sources:SOURCES.map(s=>({name:s.name,region:s.region,ship:s.ship,days:s.days}))});
});

app.post('/api/budget', (req,res)=>{ S.budget=req.body.budget||200; save(S); res.json({ok:true}); });

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

app.post('/api/approve/:index', (req,res)=>{
  const deal=(S.deals||[])[req.params.index];
  if(!deal) return res.status(404).json({error:'Not found'});
  if(!deal.buyPrice) return res.status(400).json({error:'Set buy price first'});
  S.inventory=S.inventory||[];
  S.inventory.push({id:Date.now(),name:deal.name,units:req.body.units||Math.floor((S.budget||200)/(deal.buyPrice||1)),
    buyPrice:deal.buyPrice,sellPrice:deal.sellPrice,weightKg:deal.weightKg,dateSent:new Date().toISOString(),status:'ordered',asin:deal.asin});
  log(`📦 Approved: ${deal.name}`);
  save(S); res.json({ok:true});
});

app.patch('/api/inventory/:id', (req,res)=>{ S.inventory=(S.inventory||[]).map(i=>i.id==req.params.id?{...i,...req.body}:i); save(S); res.json({ok:true}); });
app.delete('/api/inventory/:id', (req,res)=>{ S.inventory=(S.inventory||[]).filter(i=>i.id!=req.params.id); save(S); res.json({ok:true}); });

app.post('/api/gmail/check', async(req,res)=>res.json(await checkGmail()));
app.post('/api/scan', async(req,res)=>{ autoScan(); res.json({msg:'Started'}); });

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

app.post('/api/seed', (req,res)=>{
  if(S.deals?.length>0) return res.json({msg:'Already seeded'});
  S.deals=[
    {id:1,name:"Digital Instant Read Meat Thermometer",reviews:"41K+ · 4.6★",category:"Home & Kitchen",buyPrice:3.80,sellPrice:12.99,weightKg:0.12,salesRank:47,reviewCount:41000,rating:"4.6",bsrDrops90d:2700,confirmedSales90d:2700,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-instant-read-meat-thermometer.html",amzUrl:"https://www.amazon.co.uk/s?k=instant+read+meat+thermometer",note:"Top 5 Amazon UK Kitchen. 2,700+ confirmed sales in 90 days.",risks:["ThermoPro dominates","10-20 day delivery"],src:"Research 30 Mar 2026",sources:getSources("instant read meat thermometer")},
    {id:2,name:"Glass Olive Oil Sprayer 470ml",reviews:"38K+ · 4.4★",category:"Home & Kitchen",buyPrice:2.50,sellPrice:9.99,weightKg:0.35,bubbleWrap:true,salesRank:112,reviewCount:38000,rating:"4.4",bsrDrops90d:2200,confirmedSales90d:2200,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-olive-oil-sprayer-glass.html",amzUrl:"https://www.amazon.co.uk/s?k=olive+oil+sprayer+glass",note:"Air fryer trend. 2,200+ confirmed sales in 90 days.",risks:["Glass fragile","Low per-unit profit"],src:"Research 30 Mar 2026",sources:getSources("olive oil sprayer glass")},
    {id:3,name:"8-Blade Vegetable Chopper",reviews:"124K+ · 4.5★",category:"Home & Kitchen",buyPrice:9.50,sellPrice:19.99,weightKg:0.80,salesRank:23,reviewCount:124500,rating:"4.5",bsrDrops90d:3500,confirmedSales90d:3500,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-vegetable-chopper-8-blade.html",amzUrl:"https://www.amazon.co.uk/s?k=vegetable+chopper+8+blade",note:"#1 kitchen gadget. 3,500+ confirmed sales in 90 days.",risks:["Fullstar dominates","Higher buy-in"],src:"Research 30 Mar 2026",sources:getSources("vegetable chopper 8 blade")},
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
  console.log(`\n🧠 FBA Brain v4.0 FINAL — http://localhost:${PORT}`);
  console.log(`   Keepa: ${process.env.KEEPA_API_KEY?'✅':'❌'}  Gmail: ${process.env.GMAIL_CLIENT_ID?'✅':'❌'}`);
  console.log(`   📧 Gmail: /2min  🔍 Scan: /6hr  📦 Stock: /day`);
  console.log(`   🔬 Quality: ReviewMeta + Return Rate + Seasonality + Private Label`);
  console.log(`   📝 Listing Generator: Auto-titles, bullets, description, keywords`);
  console.log(`   💰 Tax: Income tax + NI + VAT threshold tracker`);
  console.log(`   🌍 ${SOURCES.length} global sources configured\n`);
  if(!S.deals?.length) { S.deals=[
    {id:1,name:"Digital Instant Read Meat Thermometer",reviews:"41K+ · 4.6★",category:"Home & Kitchen",buyPrice:3.80,sellPrice:12.99,weightKg:0.12,salesRank:47,reviewCount:41000,rating:"4.6",bsrDrops90d:2700,confirmedSales90d:2700,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-instant-read-meat-thermometer.html",amzUrl:"https://www.amazon.co.uk/s?k=instant+read+meat+thermometer",note:"Top 5 Amazon UK Kitchen. 2,700+ confirmed sales in 90 days.",risks:["ThermoPro dominates","10-20 day delivery"],src:"Research 30 Mar 2026",sources:getSources("instant read meat thermometer")},
    {id:2,name:"Glass Olive Oil Sprayer 470ml",reviews:"38K+ · 4.4★",category:"Home & Kitchen",buyPrice:2.50,sellPrice:9.99,weightKg:0.35,bubbleWrap:true,salesRank:112,reviewCount:38000,rating:"4.4",bsrDrops90d:2200,confirmedSales90d:2200,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-olive-oil-sprayer-glass.html",amzUrl:"https://www.amazon.co.uk/s?k=olive+oil+sprayer+glass",note:"Air fryer trend. 2,200+ confirmed sales in 90 days.",risks:["Glass fragile","Low per-unit profit"],src:"Research 30 Mar 2026",sources:getSources("olive oil sprayer glass")},
    {id:3,name:"8-Blade Vegetable Chopper",reviews:"124K+ · 4.5★",category:"Home & Kitchen",buyPrice:9.50,sellPrice:19.99,weightKg:0.80,salesRank:23,reviewCount:124500,rating:"4.5",bsrDrops90d:3500,confirmedSales90d:3500,from:"AliExpress",buyUrl:"https://www.aliexpress.com/w/wholesale-vegetable-chopper-8-blade.html",amzUrl:"https://www.amazon.co.uk/s?k=vegetable+chopper+8+blade",note:"#1 kitchen gadget. 3,500+ confirmed sales in 90 days.",risks:["Fullstar dominates","Higher buy-in"],src:"Research 30 Mar 2026",sources:getSources("vegetable chopper 8 blade")},
  ]; save(S); log('Seeded 3 starter deals'); }
});
