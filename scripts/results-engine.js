// scripts/lib/results-engine.js
//
// The results fetch, shared by the scheduled run and the historic backfill.
//
//   const engine = require('./lib/results-engine');
//   const r = await engine.run({ competitions, ignoreSeasonEnded, writeLastRound, label });
//   process.exit(r.exitCode);
//
// WHY THIS EXISTS
// scripts/backfill.js needs the same queries, the same result traversal and the
// same dedup as scripts/fetch-results.js, differing only in where the season
// list comes from, whether the season-ended guard applies, and whether
// lastRound is written. A second copy of that logic would drift, and
// working_practice.md is explicit that authority comes from being exercised —
// the scheduled path runs this code roughly sixteen times a weekend, so it is
// the proven one and the backfill borrows it rather than reimplementing it.
//
// Everything below was moved out of fetch-results.js unchanged apart from four
// marked edits: the two path constants that shifted when the file moved into
// lib/, the dead catch in fetchGrade, and the lastRound and compLogos merges.
//
// This module NEVER calls process.exit. The caller owns the exit code.
//
// Design: storage_ingestion_design.md §6.1.

// Bump on every change. Printed by run() so a stale copy in an Actions log is
// distinguishable from a real failure.
const ENGINE_VERSION = 'v1 2026-08-12';

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────

// One level deeper than fetch-results.js was: scripts/lib -> repo root.
const ROOT         = path.resolve(__dirname, '..', '..');
const CONFIG_PATH  = path.join(ROOT, 'config.json');
const GRADES_PATH  = path.join(ROOT, 'data', 'grades.json');
const DATA_PATH    = path.join(ROOT, 'data', 'data.json');

// ─── Config ───────────────────────────────────────────────────────────────────

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '200', 10);
// API_URL and USER_AGENT moved to scripts/lib/playhq.js — leaving copies here
// would invite someone to change the endpoint in a file that no longer uses it.

// ─── Date helper ─────────────────────────────────────────────────────────────

function todayAEST() {
  const now = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const Q_GRADE_LIST = `
query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition {
      organisation {
        name
        logo {
          sizes {
            url
            dimensions { width height }
          }
        }
      }
    }
    grades {
      id
      name
      age { name value }
      gender { name value }
    }
  }
}`;

const Q_GRADE_ROUNDS = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    dates
    rounds {
      id
      name
      abbreviatedName
      number
      current
      isFinalsRound
      provisionalDates
    }
  }
}`;

const Q_FIXTURE = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home {
        ... on DiscoverTeam {
          id
          name
          logo { sizes { url dimensions { width height } } }
        }
      }
      away {
        ... on DiscoverTeam {
          id
          name
          logo { sizes { url dimensions { width height } } }
        }
      }
      result {
        home {
          statistics { count type { value } }
        }
        away {
          statistics { count type { value } }
        }
      }
      status { value }
      date
      allocation {
        court {
          venue {
            name
            suburb
            state
            latitude
            longitude
          }
        }
      }
    }
  }
}`;

// ─── HTTP / GraphQL ───────────────────────────────────────────────────────────
// Session and transport now live in scripts/lib/playhq.js, shared with the other
// fetchers. gqlPost keeps the same signature and resolved shape, so nothing
// below this line changed. What it fixes: all three cookies are captured in the
// required order, the session is refreshed before it expires rather than after
// it fails, and a CloudFront WAF block, an expired session and an application
// error are now told apart instead of all being "HTTP error, retry twice".

const { gqlPost, refreshSession, sleep, logSummary } = require('./playhq');
const store = require('./store');

// ─── Name helpers ─────────────────────────────────────────────────────────────

// Derive { age, rawGrade } from a PlayHQ grade name e.g. "U12 Girls B"
function parseGradeName(name, ageName, genderName) {
  // Uses structured API fields (ageName, genderName) combined with name-based
  // disambiguation where the API is too coarse (e.g. "Senior" covers
  // Senior Men, Reserves, U19.5, Veterans).

  // Clean: strip leading asterisk, normalise " - " to " "
  let n = name.replace(/^\*\s*/, '').trim();
  n = n.replace(/\s+-\s+/g, ' ').trim();

  // Parenthetical division number: "U12 Mixed (1)", "U13 Mastercraft Construction Mixed (2)"
  // Must be checked before grading detection.
  const parenDivMatch = n.match(/\((\d+)\)\s*$/);
  if (parenDivMatch) {
    const divNum = parenDivMatch[1];
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName))
      ? ' ' + genderName : '';
    if (ageName?.match(/^U\d/i)) {
      const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
      const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName)
        ? nameAgeMatch[0].toUpperCase() : ageName;
      return { age: resolvedAge + genderSuffix, rawGrade: divNum };
    }
    // Non-U age e.g. "Youth Boys (1)" where ageName=U18
    return { age: (ageName || 'Unknown') + genderSuffix, rawGrade: divNum };
  }

  // Grading rounds — "U12 Mixed Grading" (no parens) or "(Grading)" suffix
  if (/\bGrading\b/i.test(n)) {
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName))
      ? ' ' + genderName : '';
    let ageLabel;
    if (ageName?.match(/^U\d/i)) {
      // Check name for .5 suffix (e.g. "U17.5 Boys GRADING" where ageName="U17")
      const halfAgeMatch = n.match(/^U(\d+\.5)/i);
      const resolvedAge = halfAgeMatch ? halfAgeMatch[0].toUpperCase() : ageName;
      ageLabel = resolvedAge + genderSuffix;
    } else {
      ageLabel = n.replace(/\s*\bGrading\b.*$/i, '').trim();
    }
    return { age: ageLabel, rawGrade: 'Grading' };
  }

  // Extract rawGrade from name: look for Premier, Division N, letter grade, Reserves
  const divMatch   = n.match(/\b(Premier(?:\s+Division)?|Division \d+)\b/i);
  const letterMatch = n.match(/\b([A-D]\d*(?:\/[A-D]\d*)?)\s*$/i);
  const rawGrade = divMatch
    ? divMatch[1].replace(/Premier Division/i, 'Premier')
    : letterMatch ? letterMatch[1].toUpperCase() : '';

  // Junior age groups: ageName starts with U (U12, U16, U18 etc.)
  if (ageName?.match(/^U\d/i)) {
    // Prefer age from grade name when more specific than ageName
    // e.g. PlayHQ returns ageName="U17" for U17.5 competitions
    const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
    const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName)
      ? nameAgeMatch[0].toUpperCase()
      : ageName;
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName))
      ? ' ' + genderName : '';
    // If rawGrade is still empty, check for a trailing colour/division word
    // e.g. SEJ "U11 Mixed Blue" → rawGrade "Blue", "U12 Mixed Red" → "Red"
    let resolvedRawGrade = rawGrade;
    if (!resolvedRawGrade) {
      const colourMatch = n.match(/\b(Blue|Red|Green|Gold|White|Black|Yellow|Purple|Orange|Navy|Silver|Teal|Grey|Gray|Maroon|Pink)\s*$/i);
      if (colourMatch) resolvedRawGrade = colourMatch[1];
    }
    return { age: resolvedAge + genderSuffix, rawGrade: resolvedRawGrade };
  }

  // Senior/Open: use name to distinguish Senior Men / Reserves / U19.5 / Veterans
  if (ageName === 'Senior' || ageName === 'Open' || ageName?.match(/^Masters?/i) || !ageName) {
    // Veterans / Masters — name contains Veterans or ageName starts with Master
    if (/Veterans/i.test(n) || ageName?.match(/^Masters?/i)) {
      const vGender = /Women/i.test(n) ? 'Women'
        : /Men/i.test(n) ? 'Men'
        : genderName === 'Women' ? 'Women' : 'Men';
      return { age: 'Veterans', rawGrade: vGender };
    }
    // U19.5
    if (/U19\.5/i.test(n)) return { age: 'U19.5', rawGrade };
    // Reserves / Reserve
    if (/Reserves?/i.test(n)) return { age: 'Reserve ' + (genderName || 'Men'), rawGrade };
    // Senior Women / Women divisions
    if (genderName === 'Women' || /Women/i.test(n)) return { age: 'Senior Women', rawGrade };
    // Only map to 'Senior Men' if name contains 'Senior', else preserve cleaned name (e.g. 'Thirds')
    if (/Senior/i.test(n)) return { age: 'Senior ' + (genderName || 'Men'), rawGrade };
    const cleanedAge = n.replace(/\s*(Premier|Division \d+).*$/i, '').trim();
    return { age: cleanedAge || n, rawGrade };
  }

  // Other structured age (e.g. "Junior", "Intermediate")
  if (ageName) {
    return { age: ageName + (genderName ? ' ' + genderName : ''), rawGrade };
  }

  // Pure fallback: strip sponsor prefix before U-age, try letter grade pattern
  n = n.replace(/^.+?(?=U\d)/i, '').trim();
  const junior = n.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*(?:\/[A-D]\d*)?)$/i);
  if (junior) return { age: junior[1].trim(), rawGrade: junior[2].toUpperCase() };
  return { age: n, rawGrade };
}

// Strip age suffix and trailing colour word from team names e.g. "Norwood U12" → "Norwood"
function cleanTeam(name, gradeAge) {
  // Strip only the grade's own age suffix from the team name.
  // PlayHQ appends the competition age to team names (e.g. "Officer JFC U14 Girls Blue")
  // but we must only strip the matching age — "Officer JFC U13 Girls" playing in a
  // U14 Girls grade should remain "Officer JFC U13 Girls" to stay distinct.
  // If gradeAge is provided, strip only that specific age token.
  // If not provided, strip any U-age suffix (legacy fallback).
  if (gradeAge) {
    // Extract just the U-number part e.g. "U14" from "U14 Girls" or "U17.5"
    const ageNum = gradeAge.match(/^(U\d+(?:\.\d+)?)/i)?.[1];
    if (ageNum) {
      return name.replace(new RegExp('\\s+' + ageNum.replace('.','\\.')  + '\\b\\s*', 'gi'), ' ').replace(/\s+$/,'').trim();
    }
  }
  return name.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/,'').trim();
}

// ─── Round identity ───────────────────────────────────────────────────────────
// PlayHQ restarts finals numbering at 1 in every grade (verified across all 249
// grades, 2026-08-09), so a Grand Final and Round 1 both have number === 1.
// Every id and sentinel key therefore carries a token rather than a bare number.
//
// Home-and-away rounds return the bare number, so all 12,765 already-stored ids
// are byte-identical to what they were. Finals use abbreviatedName, which is
// populated on all 480 finals rounds and is stable where the name is not
// ("Preliminary Final" in EFNL, "Preliminary Finals" in WFNL, both "PF").
function roundToken(number, finalsAbbrev) {
  return finalsAbbrev ? `F:${finalsAbbrev}` : String(number);
}

// The token for an already-stored match record.
function tokenOfMatch(m) {
  return roundToken(m.round, m.isFinals ? (m.finalsAbbrev || String(m.round)) : '');
}

function getStat(stats, type) {
  const s = (stats || []).find(s => s.type.value === type);
  return s ? s.count : 0;
}

function getLogoUrl(logo) {
  if (!logo?.sizes?.length) return '';
  return (logo.sizes.find(s => s.dimensions?.width === 64) || logo.sizes[0]).url;
}

// ─── Grade discovery ──────────────────────────────────────────────────────────

async function discoverGrades(competitions) {
  // Load cached grade list
  let cached = [];
  if (fs.existsSync(GRADES_PATH)) {
    try { cached = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
    catch (e) { console.warn('Could not parse grades.json — treating as empty'); }
  }
  const cachedById = new Map(cached.map(g => [g.id, g]));

  const allGrades = [];
  let gradeChanges = false;

  for (const comp of competitions) {
    console.log(`\nDiscovering grades for: ${comp.name} (seasonID: ${comp.seasonID})`);

    let res;
    try {
      res = await gqlPost(Q_GRADE_LIST, { id: comp.seasonID });
      await sleep(FETCH_DELAY);
    } catch (e) {
      console.error(`  gradeListDiscoverSeason failed: ${e.message}`);
      continue;
    }

    const allGradesRaw = res?.data?.discoverSeason?.grades || [];
    console.log(`  Found ${allGradesRaw.length} grade(s) from PlayHQ`);

    // Filter grades using excludeGrades list from config.
    // Each entry is matched as a case-insensitive substring against the normalised grade name.
    const excludeList = (comp.excludeGrades || []).map(e => e.toLowerCase());
    const grades = excludeList.length ? allGradesRaw.filter(g => {
      const normName = g.name.toLowerCase().replace(/\bu0*(\d+)/g, 'u$1');
      if (excludeList.some(ex => normName.includes(ex))) {
        console.log(`  ~ EXCLUDED (config): ${g.name}`);
        return false;
      }
      return true;
    }) : allGradesRaw;
    if (excludeList.length) console.log(`  ${grades.length} grade(s) after filtering`);

    // Diff against cache
    const liveIds = new Set(grades.map(g => g.id));
    const cachedIds = new Set([...cachedById.keys()].filter(id =>
      cached.find(g => g.id === id)?.seasonID === comp.seasonID
    ));

    // Extract competition logo (largest available size)
    const orgLogo = res?.data?.discoverSeason?.competition?.organisation?.logo?.sizes || [];
    const compLogoUrl = orgLogo.length
      ? (orgLogo.find(s => s.dimensions?.width === 128) || orgLogo[orgLogo.length - 1]).url
      : '';

    grades.forEach(g => {
      const prev = cachedById.get(g.id);
      if (!prev) {
        console.log(`  + NEW grade: ${g.name} (${g.id})`);
        gradeChanges = true;
      } else if (prev.name !== g.name) {
        console.log(`  ~ RENAMED: "${prev.name}" → "${g.name}" (${g.id})`);
        gradeChanges = true;
      }
      allGrades.push({
        id: g.id,
        name: g.name,
        ageName: g.age?.name || '',      // e.g. "Senior", "U12", "U16"
        genderName: g.gender?.name || '', // e.g. "Men", "Women", "Girls", "Mixed"
        seasonID: comp.seasonID,
        compName: comp.name,
        compLogoUrl,
      });
    });

    // Log removals
    cachedIds.forEach(id => {
      if (!liveIds.has(id)) {
        const prev = cachedById.get(id);
        console.log(`  - REMOVED grade: ${prev?.name} (${id})`);
        gradeChanges = true;
      }
    });
  }

  // Update grades.json, preserving competitions this run did not fetch.
  //
  // Previously this wrote allGrades wholesale, which held only the competitions
  // just discovered. EFNL is the sole vip:true competition, so every VIP_ONLY
  // run shrank grades.json to EFNL's grades alone, and the next all-competition
  // run then reported the other four competitions' grades as brand new. The
  // cache oscillated on every cycle and the "+ NEW grade" log became noise that
  // buried genuine additions.
  const coveredSeasons = new Set(competitions.map(c => c.seasonID));
  const preserved = cached.filter(g => !coveredSeasons.has(g.seasonID));
  const nextCache = [...preserved, ...allGrades];

  const canon = list => JSON.stringify(
    list.map(g => [g.id, g.name, g.ageName, g.genderName, g.seasonID, g.compName])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  );
  if (canon(nextCache) !== canon(cached)) {
    fs.writeFileSync(GRADES_PATH, JSON.stringify(nextCache, null, 2), 'utf8');
    console.log(`\nUpdated grades.json (${nextCache.length} grade(s): ` +
      `${allGrades.length} fetched, ${preserved.length} preserved from other competitions)`);
  } else {
    console.log(`\nGrades unchanged (${nextCache.length} grade(s))`);
  }

  // Only the grades this run fetched are returned — the fetch loop and
  // buildGradeMeta must not act on competitions that were not refreshed.
  return allGrades;
}

// ─── Per-grade results fetcher ────────────────────────────────────────────────

async function fetchGrade(grade, knownRounds, byId, knownFinals, ignoreSeasonEnded) {
  const { id, name, ageName = '', genderName = '' } = grade;
  const { age, rawGrade } = parseGradeName(name, ageName, genderName);
  const today = todayAEST();
  const gradeKey     = `${grade.compName}|${age}|${rawGrade}`;
  const highestKnown = knownRounds.get(gradeKey) || 0;
  // Finals are tracked by abbreviation, not by number. Their numbers restart at
  // 1 and carry no ordering information relative to home-and-away rounds.
  const storedFinals = (knownFinals && knownFinals.get(gradeKey)) || new Set();

  console.log(`  known up to R${highestKnown}` +
    (storedFinals.size ? ` + finals [${[...storedFinals].join(',')}]` : ''));
  try {

  // Get round list for this grade
  let roundList;
  let gradeDates = [];
  try {
    const res = await gqlPost(Q_GRADE_ROUNDS, { gradeID: id });
    const gradeData = res?.data?.discoverGrade;
    roundList = gradeData?.rounds;
    gradeDates = gradeData?.dates || []; // e.g. ["2026-04","2026-05","2026-08"]
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`    gradeRounds error: ${e.message}`);
    return { matches: [], hit403: true, logos: {}, teamOrgs: {} };
  }

  if (!roundList?.length) {
    console.log(`    no rounds returned`);
    return { matches: [], hit403: false, logos: {}, teamOrgs: {} };
  }

  // If grade-level dates are available and all are in the past,
  // the season is over — skip entirely
  // A backfill sets ignoreSeasonEnded, because every season it touches has
  // finished by definition and this guard would skip all of them. The scheduled
  // path must keep it: without it every run re-walks every completed grade.
  if (gradeDates.length && !ignoreSeasonEnded) {
    const latestMonth = gradeDates.slice().sort().pop(); // e.g. "2026-08"
    const latestDate = latestMonth + '-31'; // end of that month
    if (latestDate < today) {
      console.log(`    season ended (last month: ${latestMonth}) — skipping`);
      return { matches: [], hit403: false, logos: {}, teamOrgs: {} };
    }
  }
  if (gradeDates.length && ignoreSeasonEnded) {
    const latestMonth = gradeDates.slice().sort().pop();
    if (latestMonth + '-31' < today) console.log(`    season ended (${latestMonth}) — fetching anyway (backfill)`);
  }

  const allMatches = [];

  // Logos are collected here rather than written onto every match record.
  // teamLogos already holds each URL once, keyed by team name, and index.html
  // renders every crest from it — the per-match copies were read only on
  // provisional records, which this script does not own. Measured 2026-08-11:
  // hLogo + aLogo were 3.82 MB of a 36.57 MB data.json for 167 distinct URLs.
  const logos = {};

  // Club identity, captured at fetch time rather than reconstructed later.
  // PlayHQ logo URLs embed the owning organisation's UUID under
  // /production/afl/<uuid>/, whose first 8 hex characters are the public
  // organisation code. build-club-index.js recovered this by scanning hLogo and
  // aLogo on every match record; those are no longer stored, and here the
  // competition and age are known, so the key is exact rather than inferred.
  const teamOrgs = {};
  const orgCodeFromLogo = (url) => {
    const m = String(url || '').match(/\/production\/[a-z]+\/([0-9a-f]{8})-[0-9a-f-]+\//i);
    return m ? m[1].toLowerCase() : '';
  };

  const finalsAbbrevOf = r =>
    r.isFinalsRound === true ? (r.abbreviatedName || String(parseInt(r.number, 10) || 0)) : '';

  // Loop-invariant, so computed once rather than per round.
  const currentRoundIndex = roundList.findIndex(r => r.current);

  // Once the competition has moved into finals, the last home-and-away round is
  // complete and cannot change, so re-fetching it on every run costs one call
  // per grade for nothing. Verified safe against the partial case: a partial
  // round is excluded from highestKnown by the consecutive scan in main(), so
  // it is re-fetched by the normal path below and never reaches this branch.
  //
  // Preference order matters. `current` is PlayHQ's own marker and is the
  // stronger signal; the stored-finals fallback only applies when no round is
  // flagged current at all, which happens between seasons.
  const haFinished = currentRoundIndex !== -1
    ? roundList[currentRoundIndex].isFinalsRound === true
    : storedFinals.size > 0;

  // Position within roundList is the ONLY ordering valid across both tracks,
  // because finals numbering restarts at 1.
  const orderOf = new Map(); // round token -> index in roundList
  roundList.forEach((r, i) => {
    orderOf.set(roundToken(parseInt(r.number, 10) || 0, finalsAbbrevOf(r)), i);
  });

  // The most recently stored finals round is re-fetched every run so amended
  // finals results are picked up. Mirrors the home-and-away behaviour of always
  // re-checking the highest known round.
  let recheckFinalsIdx = -1;
  roundList.forEach((r, i) => {
    if (r.isFinalsRound === true && storedFinals.has(finalsAbbrevOf(r))) recheckFinalsIdx = i;
  });

  // If the grade's first home-and-away round number is > 1 (e.g. started at R5
  // after grading), fill R1 through firstRound-1 with bye sentinels so
  // knownRounds advances correctly and we don't retry non-existent early rounds.
  // Scoped to home-and-away deliberately: finals restart at 1, so backfilling
  // them would manufacture phantom bye records.
  const firstHARound = roundList.find(r => r.isFinalsRound !== true);
  const firstRoundNumber = parseInt(firstHARound?.number, 10) || 1;
  if (firstRoundNumber > 1 && highestKnown < firstRoundNumber - 1) {
    for (let r = Math.max(1, highestKnown + 1); r < firstRoundNumber; r++) {
      const byeKey = `${grade.compName}|${age}|${rawGrade}|${r}|__bye__`;
      if (!byId.has(byeKey)) {
        console.log(`    R${r} ... implied bye (grade starts at R${firstRoundNumber})`);
        allMatches.push({ id: byeKey, age, rawGrade, round: r, compName: grade.compName,
          home: '__bye__', away: '__bye__',
          hScore:0, hG:0, hB:0, aScore:0, aG:0, aB:0,
          venue:'', venueUrl:'', date:'', isBye: true });
      }
    }
  }

  for (const round of roundList) {
    const { id: roundID, provisionalDates, isFinalsRound, current } = round;
    const number   = parseInt(round.number, 10) || 0;
    const isFinals = isFinalsRound === true;
    const fAbbrev  = finalsAbbrevOf(round);
    const fName    = isFinals ? (round.name || '') : '';
    const rToken   = roundToken(number, fAbbrev);
    const rLabel   = isFinals ? (fName || fAbbrev) : `R${number}`;
    const rIndex   = roundList.indexOf(round);

    // Skip already-stored rounds, on the appropriate track.
    if (isFinals) {
      if (storedFinals.has(fAbbrev) && rIndex !== recheckFinalsIdx) {
        console.log(`    ${rLabel} ... already stored`);
        continue;
      }
      if (storedFinals.has(fAbbrev)) {
        console.log(`    ${rLabel} ... re-checking latest stored finals round`);
        // fall through to fetch
      }
    } else {
      // Always re-fetch the highest known round in case it was partial, or
      // results were amended after storage.
      if (number < highestKnown) {
        console.log(`    R${number} ... already stored`);
        continue;
      }
      if (number === highestKnown) {
        if (haFinished) {
          console.log(`    R${number} ... home-and-away complete, finals under way — not re-checking`);
          continue;
        }
        console.log(`    R${number} ... re-checking latest stored round`);
        // fall through to fetch
      }
    }

    // Future-round detection strategy:
    // 1. If ANY round in this grade is marked current, trust that entirely.
    //    Rounds after current haven't been played. Rounds before current have.
    //    provisionalDates is ignored — it contains data entry errors in PlayHQ
    //    (e.g. Premier Reserve Men R1 shows 2026-11-04 instead of 2026-04-11).
    // 2. If NO round is marked current (season not started or finished),
    //    fall back to provisionalDates but only stop if > 90 days away.
    if (currentRoundIndex !== -1) {
      // A current round exists — use it as the cutoff
      const roundIndex = roundList.indexOf(round);
      if (roundIndex > currentRoundIndex) {
        console.log(`    ${rLabel} ... beyond current round — stopping`);
        break;
      }
      // Rounds up to and including current are fetched (may have finals)
    } else {
      // No current round flagged — use grade-level dates to check if season has started.
      // provisionalDates on individual rounds is unreliable (data entry errors in PlayHQ).
      // If the grade's first active month is still in the future, stop here.
      if (gradeDates.length) {
        const earliestMonth = gradeDates.slice().sort()[0]; // e.g. "2026-04"
        if (earliestMonth > today.slice(0, 7)) {
          console.log(`    ${rLabel} ... season not started yet (starts ${earliestMonth}) — stopping`);
          break;
        }
      } else {
        // No grade dates — last resort: provisionalDates > 90 days
        const dates = (provisionalDates || []).map(d => {
          const dt = new Date(d);
          return isNaN(dt) ? d : dt.toISOString().slice(0, 10);
        });
        const earliest = dates.length ? dates.slice().sort()[0] : null;
        if (earliest) {
          const daysAhead = (new Date(earliest) - new Date(today)) / (1000 * 60 * 60 * 24);
          if (daysAhead > 90) {
            console.log(`    ${rLabel} ... future (${earliest}, ${Math.round(daysAhead)} days away) — stopping`);
            break;
          }
        }
      }
    }

    // Skip fixture fetch if this round is already stored as a bye sentinel
    const byeKey = `${grade.compName}|${age}|${rawGrade}|${rToken}|__bye__`;
    if (byId.has(byeKey)) {
      // Already know it's a bye — push sentinel and continue without API call
      allMatches.push(byId.get(byeKey));
      continue;
    }

    process.stdout.write(`    ${rLabel}${isFinals ? ' [Finals]' : ''} ... `);

    let fixtureRes;
    let fetchAttempts = 0;
    while (fetchAttempts < 2) {
      try {
        fixtureRes = await gqlPost(Q_FIXTURE, { roundID });
        await sleep(FETCH_DELAY);
        break;
      } catch (e) {
        fetchAttempts++;
        if (fetchAttempts >= 2) {
          console.log(`API error after ${fetchAttempts} attempts: ${e.message} — skipping round`);
          fixtureRes = null;
        } else {
          console.log(`API error (attempt ${fetchAttempts}): ${e.message} — retrying in 5s`);
          await sleep(5000);
        }
      }
    }
    if (!fixtureRes) continue; // skip this round, don't break — try next round

    const games = fixtureRes?.data?.discoverFixtureByRound?.games || [];
    const finalGames = games.filter(g => g.status?.value === 'FINAL');

    if (games.length === 0) {
      // No games — bye round. Push a sentinel so knownRounds advances past it.
      console.log(`bye — continuing`);
      allMatches.push({ id: `${grade.compName}|${age}|${rawGrade}|${rToken}|__bye__`,
        age, rawGrade, round: number, compName: grade.compName,
        ...(isFinals ? { isFinals: true, finalsAbbrev: fAbbrev, finalsName: fName } : {}),
        home: '__bye__', away: '__bye__',
        hScore:0, hG:0, hB:0, aScore:0, aG:0, aB:0,
        venue:'', venueUrl:'', date:'', isBye: true });
      continue;
    }

    if (finalGames.length === 0) {
      // Games scheduled but none final — not played yet, stop
      console.log(`scheduled, not yet played — stopping`);
      break;
    }

    const matches = [];
    for (const game of finalGames) {
      const homeName = cleanTeam(game.home?.name || '', age);
      const awayName = cleanTeam(game.away?.name || '', age);
      if (!homeName || !awayName) continue;

      const hStats = game.result?.home?.statistics || [];
      const aStats = game.result?.away?.statistics || [];
      const hG     = getStat(hStats, 'TOTAL_GOALS');
      const hB     = getStat(hStats, 'TOTAL_BEHINDS');
      const hScore = getStat(hStats, 'TOTAL_SCORE');
      const aG     = getStat(aStats, 'TOTAL_GOALS');
      const aB     = getStat(aStats, 'TOTAL_BEHINDS');
      const aScore = getStat(aStats, 'TOTAL_SCORE');

      const venue    = game.allocation?.court?.venue?.name    || '';
      const vSuburb  = game.allocation?.court?.venue?.suburb  || '';
      const vLat     = game.allocation?.court?.venue?.latitude  || '';
      const vLng     = game.allocation?.court?.venue?.longitude || '';
      const venueUrl = vLat && vLng ? `https://maps.google.com/?q=${vLat},${vLng}` : '';

      // Dedup key — same as dashboard
      const matchId = `${grade.compName}|${age}|${rawGrade}|${rToken}|${[homeName, awayName].sort().join('|')}`;

      matches.push({
        id: matchId, age, rawGrade, round: number,
        ...(isFinals ? { isFinals: true, finalsAbbrev: fAbbrev, finalsName: fName } : {}),
        compName: grade.compName,
        home: homeName, away: awayName,
        hScore, hG, hB,
        aScore, aG, aB,
        venue, vSuburb, venueUrl,
        date: game.date || '',
      });

      const hUrl = getLogoUrl(game.home?.logo);
      const aUrl = getLogoUrl(game.away?.logo);
      if (hUrl) logos[homeName] = hUrl;
      if (aUrl) logos[awayName] = aUrl;

      // Keyed comp|team|age, matching rebuildRoster and teamClub exactly. Age is
      // load-bearing: cleanTeam strips it, and PlayHQ registers the senior and
      // junior arms of a club as separate organisations.
      const hOrg = orgCodeFromLogo(hUrl);
      const aOrg = orgCodeFromLogo(aUrl);
      if (hOrg) teamOrgs[`${grade.compName}|${homeName}|${age}`] = hOrg;
      if (aOrg) teamOrgs[`${grade.compName}|${awayName}|${age}`] = aOrg;
    }

    const isPartial = finalGames.length < games.length;
    if (isPartial) {
      console.log(`${matches.length} result(s) (PARTIAL — ${games.length - finalGames.length} game(s) not yet final)`);
      // Store a partial sentinel so this round is re-fetched next run
      allMatches.push({
        id: `${grade.compName}|${age}|${rawGrade}|${rToken}|__partial__`,
        age, rawGrade, round: number, compName: grade.compName,
        ...(isFinals ? { isFinals: true, finalsAbbrev: fAbbrev, finalsName: fName } : {}),
        home: '__partial__', away: '__partial__',
        hScore:0, hG:0, hB:0, aScore:0, aG:0, aB:0,
        venue:'', venueUrl:'', date:'', isPartial: true,
      });
    } else {
      console.log(`${matches.length} result(s)`);
    }
    allMatches.push(...matches);
  }

  // Post-loop: if a partial round exists but any later round has complete results,
  // the partial will never be completed (forfeit, error etc.) — remove its sentinel.
  // Ordering MUST come from position in roundList, not from round number.
  // Finals restart at 1, so "R1 partial vs R14 complete" and "GF partial vs R14
  // complete" are not comparable by number and would promote the wrong records.
  const idxOfMatch = m => {
    const i = orderOf.get(tokenOfMatch(m));
    return i === undefined ? -1 : i;
  };
  const ownGrade = m =>
    m.compName === grade.compName && m.age === age && m.rawGrade === rawGrade;
  const completeIdx = allMatches
    .filter(m => !m.isPartial && !m.isBye && ownGrade(m))
    .map(idxOfMatch)
    .filter(i => i >= 0);
  const maxCompleteIdx = completeIdx.length ? Math.max(...completeIdx) : -1;
  const stalledPartials = allMatches.filter(m => {
    if (!m.isPartial) return false;
    const i = idxOfMatch(m);
    return i >= 0 && i < maxCompleteIdx;
  });
  if (stalledPartials.length) {
    stalledPartials.forEach(m => {
      const lbl = m.isFinals ? (m.finalsName || m.finalsAbbrev) : `R${m.round}`;
      console.log(`    ${lbl} partial promoted to complete (a later round is complete)`);
    });
    const stalledTokens = new Set(stalledPartials.map(tokenOfMatch));
    return {
      matches: allMatches.filter(m => !(m.isPartial && stalledTokens.has(tokenOfMatch(m)))),
      hit403: false,
      logos,
      teamOrgs,
    };
  }

  return { matches: allMatches, hit403: false, logos, teamOrgs };
  } catch (e) {
    // allMatches, logos and teamOrgs are declared INSIDE the try above, so the
    // previous version's `return allMatches` threw ReferenceError here and took
    // the whole run down instead of skipping one grade. Verified 2026-08-12.
    //
    // Partial results are deliberately discarded rather than returned. A grade
    // that threw part-way through would otherwise advance knownRounds past
    // rounds it never stored, and the gap would never be re-fetched. Returning
    // nothing is idempotent: the next run fetches the grade from where it was.
    console.error(`  FATAL ERROR in [${name}]: ${e.message}`);
    return { matches: [], hit403: false, logos: {}, teamOrgs: {}, failed: true };
  }
}

// ─── Grade metadata ───────────────────────────────────────────────────────────
// One map carrying everything the dashboard needs to know about a grade that it
// cannot work out from a match record: strength rank, level and gender.
//
//   gradeMeta["EFNL 2026|U12|A"] = { r: 1, lvl: 'junior', g: 'M' }
//
// RANK. PlayHQ returns grades strongest-first within each age, verified across
// all five competitions on 2026-08-09:
//   EFNL  U11 -> A, B, C, D1, D2
//   SER   U13 -> Premier Division, Blue, Gold, Navy, Orange
//   SEJ   U11 -> Blue, Red
// The colour-named grades carry no order in their names, so this ordering is
// the only sound source of strength. Rank is meaningful only within one
// competition and one age — never compare an EFNL "A" with an SER "Blue".
//
// LEVEL and GENDER come from the API rather than from the grade name.
// Q_GRADE_LIST already selects age{name value} and gender{name value}, and
// discoverGrades already stores them; nothing downstream was reading them.
// This matters: PlayHQ classifies U19.5 as SENIOR, so any "starts with U" rule
// gets it wrong. It also returns ageName "U17" for U17.5 competitions.
function buildGradeMeta(grades) {
  const meta = {};
  const next = new Map(); // "comp|age" -> rank counter

  // PlayHQ age values: U7..U23, JUNIOR, INTERMEDIATE, SENIOR, OPEN, MASTER,
  // MASTERS_35S.., UNSPECIFIED. Intermediate is treated as junior because it is
  // age-restricted; it has not been observed in any of these competitions.
  const levelOf = (ageName, parsedAge) => {
    const v = String(ageName || '').trim();
    if (/^U\d/i.test(v) || /^(junior|intermediate)/i.test(v)) return 'junior';
    if (/^(senior|open|master)/i.test(v)) return 'senior';
    return /^U\d/i.test(parsedAge || '') ? 'junior' : 'senior';
  };

  // Boys, Mixed and Men are one group; Girls and Women the other.
  const genderOf = (genderName, parsedAge, rawGrade) => {
    const v = String(genderName || '').trim();
    if (/^(girls|women)s?$/i.test(v)) return 'F';
    if (v) return 'M';
    return /\b(girls|women)\b/i.test(`${parsedAge || ''} ${rawGrade || ''}`) ? 'F' : 'M';
  };

  for (const g of grades) {
    const { age, rawGrade } = parseGradeName(g.name, g.ageName, g.genderName);
    // Grading is a pre-season sorting pool, not a competitive tier. It would
    // otherwise consume a rank slot and push every real grade down one.
    if (rawGrade === 'Grading') continue;

    const key = `${g.compName}|${age}|${rawGrade}`;
    const ageKey = `${g.compName}|${age}`;
    const r = (next.get(ageKey) || 0) + 1;
    next.set(ageKey, r);

    // Two PlayHQ grades parsing to one key would silently overwrite each other
    // and corrupt the ranking. Report it rather than let it pass.
    if (meta[key]) {
      console.warn(`  WARNING: two grades resolve to "${key}" — ranks ${meta[key].r} and ${r}; keeping ${meta[key].r}`);
      continue;
    }
    meta[key] = {
      r,
      lvl: levelOf(g.ageName, age),
      g:   genderOf(g.genderName, age, rawGrade),
    };
  }
  return meta;
}

// ─── Roster rebuild ───────────────────────────────────────────────────────────
// Current grade for each team = the grade they appeared in during their
// highest round number across all stored matches.
// If a team appears in two different grades in the same round (shouldn't
// happen but could during a transition), alphabetically earlier grade wins
// and a warning is logged.

function rebuildRoster(matches) {
  // Finals are excluded explicitly. With finals at 1-3 and home-and-away at
  // 14-18 they could never win the `round > prev.round` comparison anyway, but
  // that is a numeric coincidence rather than a rule, and it would break the
  // moment a competition ran a short home-and-away season.
  matches = matches.filter(m => !m.isFinals);

  // Key by "teamName|age" so clubs with multiple teams in different age groups
  // don't overwrite each other. e.g. "Norwood|U12" and "Norwood|U14" are separate.
  // latest: "teamName|age" → { grade, age, round }
  const latest = new Map();

  matches.forEach(m => {
    [
      { name: m.home, grade: m.rawGrade, age: m.age, round: m.round, compName: m.compName || '' },
      { name: m.away, grade: m.rawGrade, age: m.age, round: m.round, compName: m.compName || '' },
    ].forEach(({ name, grade, age, round, compName }) => {
      const key = `${compName}|${name}|${age}`;
      const prev = latest.get(key);
      if (!prev || round > prev.round) {
        latest.set(key, { grade, age, round, compName });
      } else if (round === prev.round && grade !== prev.grade) {
        // Same team, same age, same round, different grades
        // Prefer non-empty grade, then alphabetically earlier (A < B < C < D)
        const winner = (!prev.grade && grade) ? grade
          : (prev.grade && !grade) ? prev.grade
          : [prev.grade, grade].sort()[0];
        console.warn(`  WARNING: ${name} (${age}) in both grade ${prev.grade} and ${grade} in R${round} — keeping ${winner}`);
        latest.set(key, { ...prev, grade: winner, compName });
      }
    });
  });

  // Return roster keyed by "teamName|age": { grade, age }
  // Dashboard currentGrade() must look up by this same key
  const roster = {};
  latest.forEach(({ grade, age, compName }, key) => {
    roster[key] = { grade, age, compName };
  });
  return roster;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// getSession() removed — scripts/lib/playhq.js acquires a session on first use
// and refreshes it on age or on a 403, which the old once-at-startup version
// could not do.



// ─── Data directory ───────────────────────────────────────────────────────────
// Machine-written JSON lives in data/. config.json stays at the repo root because
// it is hand-edited configuration, not generated data.
//
// This moves any legacy root-level copies on first run, so the relocation needs
// no manual git operation — Mark has no local git. It no-ops thereafter. If a
// file exists in BOTH places, data/ is authoritative and the root copy is
// deleted, which is what happens on the run after the move.
function ensureDataDir() {
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['data.json', 'grades.json', 'clubs.json']) {
    const legacy = path.join(ROOT, name);
    const target = path.join(dir, name);
    if (!fs.existsSync(legacy)) continue;
    if (fs.existsSync(target)) {
      fs.unlinkSync(legacy);
      console.log(`Removed superseded root copy of ${name}`);
    } else {
      fs.renameSync(legacy, target);
      console.log(`Moved ${name} -> data/${name}`);
    }
  }
}/**
 * Fetch results for a set of competition-seasons and write them through store.js.
 *
 * This is the body of what used to be fetch-results.js main(), unchanged except
 * where marked. Both callers run this same code: scripts/fetch-results.js on the
 * schedule and scripts/backfill.js for history. Authority comes from being
 * exercised, so there is deliberately no second copy of the fetch logic.
 *
 * @param {object}   o
 * @param {object[]} o.competitions       [{ name, seasonID, excludeGrades }].
 *                                        `name` is the compName and is half of
 *                                        every stored key — "EFNL 2025", not "EFNL".
 * @param {string[]} [o.scope]            store scope; defaults to the comp names.
 * @param {boolean}  [o.ignoreSeasonEnded] bypass the season-ended guard (backfill).
 * @param {boolean}  [o.writeLastRound]   default true; false leaves lastRound alone.
 * @param {string}   [o.label]            log prefix.
 * @returns {Promise<{exitCode:number,newCount:number,updatedCount:number,
 *                    gradeMetaChanged:boolean,total:number,
 *                    failedGrades:string[],erroredGrades:string[]}>}
 *          Never calls process.exit — the caller owns the exit code.
 */
async function run(o) {
  const competitions      = o.competitions || [];
  const ignoreSeasonEnded = o.ignoreSeasonEnded === true;
  const writeLastRound    = o.writeLastRound !== false;
  const label             = o.label || 'results-engine';

  ensureDataDir();
  if (!competitions.length) throw new Error('run(): no competitions supplied');
  await refreshSession();
  console.log(`[${label} ${ENGINE_VERSION}] ${competitions.length} competition-season(s): ` +
    competitions.map(c => c.name).join(', '));
  if (ignoreSeasonEnded) console.log(`[${label}] season-ended guard BYPASSED (backfill mode)`);
  if (!writeLastRound)    console.log(`[${label}] lastRound will NOT be written`);


  // 2. Load existing data, scoped to the competitions this run covers.
  // store.load() returns the shape data.json had, so nothing below changes.
  // Scoping is what makes a VIP-only run safe: the other organisations' files
  // are never opened, so they cannot be overwritten.
  const storeScope = o.scope || competitions.map(c => c.name);
  let existing = { matches: [], players: [], gotwFlags: {} };
  {
    try {
      existing = store.load(storeScope);
      console.log(`Loaded ${storeScope.length} organisation scope(s): ${(existing.matches || []).length} existing match(es)`);
    } catch (e) {
      throw new Error(`store.load failed: ${e.message}`);
    }
  }
  if (!existing.matches.length) {
    console.log('No existing matches in scope — will create');
  }

  // 3. Discover grades (diffs against grades.json cache)
  const grades = await discoverGrades(competitions);
  if (!grades.length) throw new Error('No grades found for the requested season(s)');

  // 4. Build dedup map and per-grade highest-known-round map from existing matches
  const byId = new Map();
  const knownRounds = new Map(); // "age|rawGrade" → highest round in data.json

  // Build a map of which rounds exist per grade, and which are partial
  const roundsByGrade = new Map();
  const partialRounds = new Map(); // key → Set of partial round numbers
  // Finals tracked separately by abbreviation — their numbers restart at 1 and
  // would corrupt the consecutive-from-R1 scan if mixed into roundsByGrade.
  const finalsByGrade = new Map(); // key → Set of finals abbreviations stored
  const partialFinals = new Map(); // key → Set of finals abbreviations that are partial
  (existing.matches || []).forEach(m => {
    byId.set(m.id, m);
    // Scheduled (fixture-only) records must not affect highestKnown —
    // they have no scores and would cause fetch-results to skip real rounds
    if (m.scheduled) return;
    // Key by compName|age|rawGrade to keep competitions separate
    const key = `${m.compName || ''}|${m.age}|${m.rawGrade}`;
    if (m.isFinals) {
      const ab = m.finalsAbbrev || String(m.round);
      if (!finalsByGrade.has(key)) finalsByGrade.set(key, new Set());
      finalsByGrade.get(key).add(ab);
      if (m.isPartial) {
        if (!partialFinals.has(key)) partialFinals.set(key, new Set());
        partialFinals.get(key).add(ab);
      }
      return; // finals must never reach the home-and-away round scan
    }
    if (!roundsByGrade.has(key)) roundsByGrade.set(key, new Set());
    roundsByGrade.get(key).add(m.round);
    // Track partial rounds — these must be re-fetched even if within consecutive count
    if (m.isPartial) {
      if (!partialRounds.has(key)) partialRounds.set(key, new Set());
      partialRounds.get(key).add(m.round);
    }
  });

  // knownRounds = highest *consecutive* home-and-away round from R1 with no
  // gaps, excluding partial rounds (they need re-fetching).
  roundsByGrade.forEach((rounds, key) => {
    const partial = partialRounds.get(key) || new Set();
    let consecutive = 0;
    for (let r = 1; rounds.has(r) && !partial.has(r); r++) consecutive = r;
    knownRounds.set(key, consecutive);
  });

  // knownFinals = finals abbreviations stored AND complete. A partial finals
  // round is deliberately absent so it gets re-fetched.
  const knownFinals = new Map();
  finalsByGrade.forEach((abbrevs, key) => {
    const partial = partialFinals.get(key) || new Set();
    knownFinals.set(key, new Set([...abbrevs].filter(a => !partial.has(a))));
  });

  // 5. Fetch new results for each grade — sequential with cooldown
  let newCount = 0;
  let updatedCount = 0;
  let fetchError = null;
  let resultsGradeIdx = 0;
  let consecutive403s = 0;
  const fetchedLogos = {};
  const fetchedTeamOrgs = {};
  // A grade whose fetch threw. Counted rather than lost: a backfill across
  // thirteen seasons must not report success having silently skipped grades.
  const failedGrades = [];
  // A grade whose gradeRounds call errored. That path returns an empty grade
  // with hit403 set, which is indistinguishable from a grade that genuinely has
  // no rounds unless it is recorded here. The scheduled run tolerates it because
  // the next run retries; a backfill has no next run, so it must be able to see
  // the difference. Found 2026-08-12 by a verification whose forced failure went
  // down this path instead of the one it was aimed at.
  const erroredGrades = [];

  for (const grade of grades) {
    resultsGradeIdx++;
    console.log(`\n[${resultsGradeIdx}/${grades.length}] ${grade.compName} — ${grade.name}`);
    if (resultsGradeIdx > 1 && (resultsGradeIdx - 1) % 20 === 0) {
      console.log('  [cooldown 60s — letting rate limit window reset]');
      await sleep(60000);
      consecutive403s = 0;
    }
    const { matches, hit403, logos, teamOrgs, failed } = await fetchGrade(grade, knownRounds, byId, knownFinals, ignoreSeasonEnded);
    if (failed) failedGrades.push(`${grade.compName} — ${grade.name}`);
    if (hit403) erroredGrades.push(`${grade.compName} — ${grade.name}`);
    Object.assign(fetchedLogos, logos);
    Object.assign(fetchedTeamOrgs, teamOrgs);
    if (hit403) {
      consecutive403s++;
      if (consecutive403s >= 3) {
        console.log(`  [${consecutive403s} consecutive 403s — cooldown 60s]`);
        await sleep(60000);
        consecutive403s = 0;
      }
    } else {
      consecutive403s = 0;
    }

    for (const m of matches) {
      if (!m.isPartial) {
        const partialKey = `${m.compName}|${m.age}|${m.rawGrade}|${tokenOfMatch(m)}|__partial__`;
        byId.delete(partialKey);
      }
      if (byId.has(m.id)) {
        const prev = byId.get(m.id);
        const changed = ['hScore','hG','hB','aScore','aG','aB'].some(k => prev[k] !== m[k]);
        byId.set(m.id, { ...prev, ...m });
        if (changed) updatedCount++;
      } else {
        byId.set(m.id, m);
        newCount++;
      }
    }
  }

  if (fetchError) console.error(`\nFetch loop error: ${fetchError.message}`);
  console.log(`\nMatches: ${newCount} new, ${updatedCount} updated, ${byId.size} total`);

  // 6. Rebuild roster from all match history
  // Separate real matches from bye sentinels
  const allValues = Array.from(byId.values());
  const allMatches = allValues
    .filter(m => !m.isBye && !m.isPartial && !m.scheduled)
    .sort((a, b) => a.age.localeCompare(b.age)
                 || a.rawGrade.localeCompare(b.rawGrade)
                 || ((a.isFinals ? 1 : 0) - (b.isFinals ? 1 : 0))
                 || a.round - b.round);

  // Include bye sentinels in round tracking but not in output.
  // Preserve scheduled records in output unchanged — fetch-fixtures.js owns them,
  // but fetch-results.js must not strip them or the dashboard loses upcoming fixtures.
  // Two-key sort: home-and-away before finals, then by round. Sorting on round
  // alone would interleave a Grand Final (round 1) among the Round 1 games.
  const allWithByes = allValues.sort((a,b) =>
    ((a.isFinals ? 1 : 0) - (b.isFinals ? 1 : 0)) || (a.round - b.round));

  const roster = rebuildRoster(allMatches);
  console.log(`Roster: ${Object.keys(roster).length} team(s)`);

  // 7. Write data.json — preserve gotwFlags and players, replace matches and roster
  // Build lastRound map: "age|rawGrade" → highest round in data
  // Rebuilt from scratch, and written back ONLY when writeLastRound is set.
  //
  // The key is age|rawGrade with no competition and no season — the defect in
  // storage_ingestion_design.md §3. That has two consequences and they pull in
  // opposite directions, so neither merging nor replacing is right on its own:
  //
  //   Replacing on a scoped run DELETES the other competitions' entries, because
  //   this map is built from the matches in scope and assigned wholesale into
  //   core.json. Measured 2026-08-12: a VIP-only run took
  //   {"U12|A":14,"U14|B":16} to {"U12|A":14}.
  //
  //   Merging on ANY run makes it a ratchet. The comparison below only raises a
  //   value, so 2026's round 18 would survive into 2027 and never come back down
  //   to round 3. That is what the first attempt at this fix did, and the
  //   verification caught it.
  //
  // So a value keyed without a competition can only be computed correctly by a
  // run that can see every competition. A full run rebuilds it; a scoped run
  // leaves it alone entirely and it stays correct until the next full run.
  // The caller decides, because only the caller knows whether it covered
  // everything. The real fix is re-keying, which needs a migration.
  const lastRound = {};
  let strippedLogos = 0;
  // Merged over the stored map, so teams not covered by this run keep the URL
  // they already had — a VIP-only run must not drop the other competitions.
  const teamLogos = { ...(existing.teamLogos || {}), ...fetchedLogos };

  // Merged over the stored map for the same reason as teamLogos: a VIP-only run
  // covers one competition and must not delete the other four.
  const teamOrg = { ...(existing.teamOrg || {}), ...fetchedTeamOrgs };
  // Use allWithByes for round tracking so byes advance lastRound correctly
  allWithByes.forEach(m => {
    if (m.scheduled) return; // don't let fixture records affect lastRound
    // lastRound is the last home-and-away round. A finals round numbered 1 must
    // never overwrite R14, and a finals number means nothing on its own.
    const key = `${m.age}|${m.rawGrade}`;
    if (!m.isFinals && (!lastRound[key] || m.round > lastRound[key])) lastRound[key] = m.round;
    if (!m.isBye) {
      // Logos come from fetchedLogos above. Records stored before this change
      // still carry them, so they are harvested here too — that is what keeps
      // the first run after the change from losing a single URL.
      if (m.hLogo) teamLogos[m.home] = m.hLogo;
      if (m.aLogo) teamLogos[m.away] = m.aLogo;
    }
    // Then drop the per-match copies. Ordering matters: harvest above, strip
    // here, so nothing is discarded before teamLogos has absorbed it.
    // Scheduled records never reach this line — they return at the top of the
    // loop, because fetch-fixtures.js owns them and index.html reads their
    // logos to detect a provisional side.
    if ('hLogo' in m || 'aLogo' in m) {
      delete m.hLogo;
      delete m.aLogo;
      strippedLogos++;
    }
  });
  console.log(`Team-to-club codes: ${Object.keys(fetchedTeamOrgs).length} from this run, ${Object.keys(teamOrg).length} total`);
  if (strippedLogos) {
    console.log(`Stripped per-match logo URLs from ${strippedLogos} record(s) — teamLogos holds ${Object.keys(teamLogos).length}`);
  }

  // Build compLogos map: compName → logo URL.
  // Merged over the stored map for the same reason as teamLogos, teamOrg and
  // lastRound. This had the identical defect and was found while fixing
  // lastRound: compLogos is a CORE_KEY assigned wholesale, and a VIP-only run
  // discovers one competition's grades, so it reduced a five-entry map to one.
  const compLogos = { ...(existing.compLogos || {}) };
  grades.forEach(g => { if (g.compLogoUrl) compLogos[g.compName] = g.compLogoUrl; });

  // Merged per COMPETITION, not per key. A VIP_ONLY run only discovers the VIP
  // competitions' grades, so replacing wholesale would delete the others — but
  // a blind key merge is also wrong, because a renamed or withdrawn grade would
  // leave its old key behind forever and inflate the tier count that team rows
  // display ("2/5" where only four grades exist).
  // So: for every competition this run actually covered, its metadata is
  // rebuilt from scratch; every other competition is left exactly as it was.
  const covered = new Set(grades.map(g => g.compName));
  const kept = {};
  for (const [k, v] of Object.entries(existing.gradeMeta || {})) {
    const comp = k.slice(0, k.indexOf('|'));
    if (!covered.has(comp)) kept[k] = v;
  }
  const gradeMeta = { ...kept, ...buildGradeMeta(grades) };
  // Compared on sorted entries so key insertion order cannot register as a
  // change. gradeMeta is the first thing this script writes that can change
  // without any match changing — a new grade, or simply the first run after the
  // feature landed — so the exit code below has to account for it or the work
  // is written to data.json and then never committed.
  const canon = o => JSON.stringify(Object.entries(o || {}).sort((a,b) => a[0] < b[0] ? -1 : 1));
  const gradeMetaChanged = canon(existing.gradeMeta) !== canon(gradeMeta);
  console.log(`Grade metadata: ${Object.keys(gradeMeta).length} grade(s)` +
    (gradeMetaChanged ? ' (changed)' : ' (unchanged)'));

  const merged = {
    ...existing,
    matches: allWithByes,
    roster,
    gradeMeta,
    // Omitted unless the caller covered every competition. `...existing` then
    // carries the stored map through untouched, so store.save writes back what
    // was already there rather than a version built from a partial view.
    ...(writeLastRound ? { lastRound } : {}),
    teamLogos,
    teamOrg,
    compLogos,
    lastUpdated: new Date().toISOString(),
    lastResultsFetch: new Date().toISOString(),
    // Preserve lastStatsFetch from existing data — only fetch-stats.js updates it
    lastStatsFetch: existing.lastStatsFetch || null,
  };

  // data.json is written MINIFIED. At 53MB pretty-printed it was 98% of the
  // repository, checked out by every workflow run and downloaded by every
  // visitor. All four writers — fetch-results, fetch-fixtures, fetch-stats and
  // build-club-index — must agree, or whichever runs next re-inflates the file
  // and every run produces a whole-file diff.
  store.report(store.save(merged, storeScope), label);

  // Never collapse a failure into "no data" — the run's own call outcomes,
  // printed so a quiet degradation is visible in the log rather than inferred
  // from a low match count.
  logSummary(label);

  if (failedGrades.length) {
    console.error(`\n  WARNING: ${failedGrades.length} grade(s) failed and returned nothing:`);
    for (const g of failedGrades) console.error(`    ${g}`);
  }
  if (erroredGrades.length) {
    console.error(`\n  WARNING: ${erroredGrades.length} grade(s) could not fetch a round list:`);
    for (const g of erroredGrades) console.error(`    ${g}`);
  }

  // The caller owns the exit code. An engine that called process.exit could not
  // be tested, and a backfill wants to treat a failed grade as fatal where the
  // scheduled run does not.
  let exitCode = 0;
  if (newCount === 0 && updatedCount === 0 && !gradeMetaChanged) {
    console.log('No match or grade metadata changes');
    exitCode = 2;
  } else if (newCount === 0 && updatedCount === 0) {
    console.log('No match changes, but grade metadata changed');
  }
  return { exitCode, newCount, updatedCount, gradeMetaChanged, total: byId.size,
           failedGrades, erroredGrades };
}
module.exports = {
  run,
  // Exported for the verification script and for any future caller that needs a
  // piece rather than the whole run. Not exported to encourage reuse by copying.
  discoverGrades,
  fetchGrade,
  buildGradeMeta,
  rebuildRoster,
  parseGradeName,
  cleanTeam,
  ENGINE_VERSION,
};
